/**
 * The wire from the SDK's own `result` message to the Governor's burn ledger.
 *
 * No live SDK call anywhere here: `Engine` is driven by a tiny async generator standing
 * in for `query()`, and `SdkEngine` by the same fake-query shape `sdk-engine.test.ts`
 * already uses, so this file spends nothing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import { Engine, type QueryFn } from '../../src/adapter/engine.js';
import type { EngineEvent } from '../../src/adapter/events.js';
import { SdkEngine } from '../../src/forge/sdkengine.js';
import { replay } from '../../src/forge/journal.js';

let home: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-result-usage-'));
  journalPath = join(home, 'fleet.jsonl');
  process.env['FORGE_HOME'] = home;
});

describe('the adapter surfaces modelUsage as a result-usage event', () => {
  it('emits result-usage before turn-complete, mapped from the SDK\'s field names', async () => {
    const fn = (() => {
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's1',
          model: 'claude-sonnet-5', cwd: '/', tools: [], slash_commands: [],
        };
        yield {
          type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0.6,
          modelUsage: {
            'claude-sonnet-5': {
              inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5,
              cacheCreationInputTokens: 2, costUSD: 0.5,
            },
            'claude-haiku-4-5-20251001': {
              inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0, costUSD: 0.1,
            },
          },
        };
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = new Engine(fn);
    const seen: EngineEvent[] = [];
    engine.onEvent((event) => seen.push(event));
    engine.start({ cwd: '/', canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const usageIndex = seen.findIndex((event) => event.type === 'result-usage');
    const completeIndex = seen.findIndex((event) => event.type === 'turn-complete');
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(usageIndex);

    const usage = seen[usageIndex] as Extract<EngineEvent, { type: 'result-usage' }>;
    expect(usage.modelUsage['claude-sonnet-5']).toEqual({
      input: 100, cacheRead: 5, cacheCreation: 2, output: 10, costUsd: 0.5,
    });
    expect(usage.modelUsage['claude-haiku-4-5-20251001']?.costUsd).toBe(0.1);
  });

  it('emits nothing when the result message carries no modelUsage at all', async () => {
    const fn = (() => {
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's1',
          model: 'claude-sonnet-5', cwd: '/', tools: [], slash_commands: [],
        };
        yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = new Engine(fn);
    const seen: EngineEvent[] = [];
    engine.onEvent((event) => seen.push(event));
    engine.start({ cwd: '/', canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(seen.some((event) => event.type === 'result-usage')).toBe(false);
  });
});

describe('the live worker pipeline journals it on the segment\'s end row', () => {
  it('appends a result.usage row a replay can hand to the burn ledger', async () => {
    const fn = (() => {
      let asked = false;
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's1',
          model: 'claude-sonnet-5', cwd: '/', tools: [], slash_commands: [],
        };
        for await (const _pushed of [1] as unknown as AsyncIterable<unknown>) {
          if (asked) return;
          asked = true;
          yield {
            type: 'assistant', session_id: 's1',
            message: {
              model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }],
              usage: {
                input_tokens: 100, cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0, output_tokens: 10,
              },
            },
          };
          yield {
            type: 'result', subtype: 'success', is_error: false, duration_ms: 1,
            modelUsage: {
              'claude-sonnet-5': {
                inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0, costUSD: 0.42,
              },
            },
          };
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox'), gotchasDir: join(home, 'gotchas'), queryFn: fn,
    });
    await engine.run({
      run: 'r1', model: 'claude-sonnet-5', prompt: '# Goal\n\ndo it\n',
      cwd: join(home, 'workspace'), maxTurns: 10, env: {},
    });
    await engine.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'result.usage' && event.run === 'r1');
    expect(row).toBeTruthy();
    const modelUsage = row?.['modelUsage'] as Record<string, { costUsd: number }> | undefined;
    expect(modelUsage?.['claude-sonnet-5']?.costUsd).toBe(0.42);
  });
});
