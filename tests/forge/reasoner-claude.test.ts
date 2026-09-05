/**
 * `ClaudeReasoner`, the `claude` provider behind the `Reasoner` seam (`contracts.ts`).
 *
 * No model is called anywhere in this file: `tests/setup.ts` makes the SDK's real
 * `query` throw, and every specimen below injects its own fake `queryFn` instead,
 * exercised through the same adapter seam (`src/adapter/engine.ts`'s `QueryFn`) the
 * production runner uses -- never through a mock of `ClaudeReasoner` itself.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../src/adapter/engine.js';
import {
  ClaudeReasoner, CodexReasoner, ReasonerParseError, ReasonerTimeoutError, reasonerFor,
} from '../../src/forge/reasoner-claude.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { modelFor, modelIdFor } from '../../src/forge/policy.js';

let home: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-reasoner-claude-'));
  journalPath = join(home, 'fleet.jsonl');
});

/** A fake `query`: replies to the one prompt a `ClaudeReasoner` call ever pushes with
 *  a single assistant message (the given text, with usage) followed by a `result`. */
function fakeQuery(text: string, usage = { input: 10, cacheRead: 0, cacheCreation: 0, output: 5 }) {
  const calls: Array<{ options: Options }> = [];
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ options: params.options as Options });
    const promptIter = params.prompt as AsyncIterable<unknown>;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'reasoner-fake-session',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      for await (const _pushed of promptIter) {
        yield {
          type: 'assistant', session_id: 'reasoner-fake-session',
          message: {
            model: params.options?.model ?? '',
            content: [{ type: 'text', text }],
            usage: {
              input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead,
              cache_creation_input_tokens: usage.cacheCreation, output_tokens: usage.output,
            },
          },
        };
        yield {
          type: 'result', subtype: 'success', is_error: false, duration_ms: 5,
          total_cost_usd: 0,
        };
        return;
      }
    }
    const gen = generate() as unknown as ReturnType<QueryFn>;
    return gen;
  }) as QueryFn;
  return { fn, calls };
}

/** A fake `query` whose session never produces another message once the prompt lands:
 *  it hangs forever, the way a stalled or unreachable model would. */
function hangingQuery() {
  const calls: Array<{ options: Options }> = [];
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ options: params.options as Options });
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'reasoner-hang-session',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      await new Promise(() => {});
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn, calls };
}

/** A clock that fires every scheduled timeout immediately, so the timeout specimen
 *  below proves the budget without waiting on it. */
function instantClock() {
  const setTimeoutFn = ((cb: () => void) => {
    queueMicrotask(cb);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as typeof clearTimeout;
  return { setTimeoutFn, clearTimeoutFn };
}

describe('ClaudeReasoner', () => {
  it('yields a typed answer and journals one reasoner.call row with usage, on a valid JSON reply', async () => {
    const { fn } = fakeQuery('{"text": "yes, on task"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const result = await reasoner.call({ className: 'evaluate', prompt: 'still on task?' });
    journal.close();

    expect(result).toEqual({ text: 'yes, on task' });
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row).toBeDefined();
    expect(row?.['provider']).toBe('claude');
    expect(row?.['class']).toBe('evaluate');
    expect(row?.usage).toEqual({ input: 10, cacheRead: 0, cacheCreation: 0, output: 5 });
    expect(row?.['parsed']).toBe(true);
  });

  it('rejects with a typed parse error and journals parsed: false, on an invalid JSON reply', async () => {
    const { fn } = fakeQuery('not json at all');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await expect(reasoner.call({ className: 'evaluate', prompt: 'still on task?' }))
      .rejects.toBeInstanceOf(ReasonerParseError);
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['parsed']).toBe(false);
    expect(row?.['raw']).toBe('not json at all');
  });

  it('rejects with a typed parse error when the JSON is valid but the shape is wrong', async () => {
    const { fn } = fakeQuery('{"answer": "wrong key"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await expect(reasoner.call({ className: 'evaluate', prompt: 'still on task?' }))
      .rejects.toBeInstanceOf(ReasonerParseError);
    journal.close();
  });

  it('times out inside the injected clock\'s budget and journals reasoner.timeout, on a query that never resolves', async () => {
    const { fn } = hangingQuery();
    const { setTimeoutFn, clearTimeoutFn } = instantClock();
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({
      journal, queryFn: fn, existsConfigDir: () => false, setTimeoutFn, clearTimeoutFn,
    });

    await expect(reasoner.call({ className: 'evaluate', prompt: 'still on task?' }))
      .rejects.toBeInstanceOf(ReasonerTimeoutError);
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.timeout');
    expect(row).toBeDefined();
    expect(row?.['class']).toBe('evaluate');
  });

  it('opens the session on the model policy.ts names for the class, never a copied map', async () => {
    for (const className of ['evaluate', 'audit-lens', 'audit-judge']) {
      const { fn, calls } = fakeQuery('{"text": "ok"}');
      const journal = new Journal(journalPath);
      const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });
      await reasoner.call({ className, prompt: 'x' });
      journal.close();
      expect(calls[0]?.options.model).toBe(modelIdFor(modelFor(className)));
    }
  });

  it('asks for no tools and a single bounded turn', async () => {
    const { fn, calls } = fakeQuery('{"text": "ok"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });
    await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    expect(calls[0]?.options.allowedTools).toEqual([]);
    expect(calls[0]?.options.maxTurns).toBe(1);
    expect(calls[0]?.options.permissionMode).toBe('bypassPermissions');
  });

  it('strips the nine inherited names and ANTHROPIC_API_KEY, and pins CLAUDE_CONFIG_DIR', async () => {
    const { fn, calls } = fakeQuery('{"text": "ok"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({
      journal, queryFn: fn, existsConfigDir: () => false,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'leaked', ANTHROPIC_API_KEY: 'leaked' },
    });
    await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    const env = calls[0]?.options.env as NodeJS.ProcessEnv;
    expect(env['CLAUDE_CODE_SESSION_ID']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CONFIG_DIR']).toBeDefined();
  });
});

describe('CodexReasoner', () => {
  it('returns "not configured" without any subprocess', async () => {
    const reasoner = new CodexReasoner();
    await expect(reasoner.call({ className: 'plan', prompt: 'x' })).rejects.toThrow(/not configured/);
  });
});

describe('reasonerFor', () => {
  it('builds a ClaudeReasoner for provider claude and a CodexReasoner for provider codex', () => {
    const journal = new Journal(journalPath);
    expect(reasonerFor('claude', { journal }).provider).toBe('claude');
    expect(reasonerFor('codex', { journal })).toBeInstanceOf(CodexReasoner);
    journal.close();
  });
});
