/**
 * The cache and the queue behind it: the half where "narrated" can read Met while every
 * board in the fleet is quietly showing a template, or while every poll pays for the same
 * sentence again.
 *
 * No model is called here. Every specimen injects a fake `queryFn` through the same
 * `reasonerFor('claude', ...)` seam the server wires in production -- the narrator itself
 * is never faked, because a fake narrator would prove only that the fake works.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../../src/adapter/engine.js';
import type { NarrationFacts } from '../../../src/shared/console-model.js';
import type { SliceName } from '../../../src/shared/console-events.js';
import { Journal } from '../../../src/forge/journal.js';
import { reasonerFor } from '../../../src/forge/reasoner-claude.js';
import { narrationKey } from '../../../src/forge/console/narrate.js';
import { Narrator, passThrough } from '../../../src/forge/console/narrate-store.js';

let home: string;
let policyPath: string;

/** The repo's own policy with one field moved: a `narrate` timeout short enough that the
 *  never-resolving specimen below finishes the file instead of holding a 60-second timer
 *  open. The cap stays at the shipped 300, because the cap is what one specimen measures. */
function writePolicyFixture(timeoutMs: number): string {
  const source = join(process.cwd(), 'src', 'forge', 'model-policy.json');
  const policy = JSON.parse(readFileSync(source, 'utf8')) as {
    classes: Record<string, Record<string, unknown>>;
  };
  policy.classes['narrate'] = { ...policy.classes['narrate'], timeoutMs };
  const path = join(home, 'policy.json');
  writeFileSync(path, JSON.stringify(policy), 'utf8');
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-narrate-store-'));
  policyPath = writePolicyFixture(60_000);
  delete process.env['FORGE_NARRATE'];
});

afterEach(() => {
  delete process.env['FORGE_NARRATE'];
});

/** A fake `query` that answers each prompt with whatever `replyFor` returns for it. */
function scriptedQuery(replyFor: (prompt: string) => string) {
  const prompts: string[] = [];
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const promptIter = params.prompt as AsyncIterable<unknown>;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'narrate-fake',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      for await (const pushed of promptIter) {
        const text = String(
          (pushed as { message?: { content?: string } }).message?.content ?? '',
        );
        prompts.push(text);
        yield {
          type: 'assistant', session_id: 'narrate-fake',
          message: {
            model: params.options?.model ?? '',
            content: [{ type: 'text', text: replyFor(text) }],
            usage: {
              input_tokens: 10, cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0, output_tokens: 5,
            },
          },
        };
        yield {
          type: 'result', subtype: 'success', is_error: false, duration_ms: 1,
          total_cost_usd: 0,
        };
        return;
      }
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn, prompts };
}

/** A fake `query` whose session opens and then never says anything again -- a stalled or
 *  unreachable model. Nothing about it ever resolves. */
function neverResolvingQuery() {
  let opened = 0;
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    opened += 1;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'narrate-hang',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      await new Promise(() => {});
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn, opened: () => opened };
}

interface Rig {
  narrator: Narrator;
  journalPath: string;
  published: Array<{ slice: SliceName; reason: string; ref?: string }>;
}

function rigWith(queryFn: QueryFn, concurrency = 2): Rig {
  const journalPath = join(home, 'fleet.jsonl');
  const journal = new Journal(journalPath);
  const published: Array<{ slice: SliceName; reason: string; ref?: string }> = [];
  const reasoner = reasonerFor('claude', { journal, queryFn, cwd: home, policyPath });
  const narrator = new Narrator({
    reasoner,
    journal,
    home,
    concurrency,
    policyPath,
    publish: (slice, reason, ref) => { published.push({ slice, reason, ...(ref ? { ref } : {}) }); },
  });
  return { narrator, journalPath, published };
}

function rows(journalPath: string): Array<Record<string, unknown>> {
  let text = '';
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The falsifier's own counter: model calls read off the journal, never off the narrator's
 *  own bookkeeping, so a narrator that miscounts its own calls cannot pass this. */
function narrateCalls(journalPath: string): number {
  return rows(journalPath)
    .filter((row) => row['event'] === 'reasoner.call' && row['class'] === 'narrate').length;
}

const merged: NarrationFacts = {
  surface: 'lane.did',
  facts: { lane: 'NWR-96', pr: 412, checks: 'passed', state: 'done' },
  template: 'Checks passed and the council approved PR #412.',
};

const acceptedReply = JSON.stringify({
  glance: 'Checks passed and the council approved PR #412.',
  detail: 'Every check on PR #412 passed and the council approved it, so NWR-96 is done and ready to merge.',
});

describe('the model never blocks a route', () => {
  it('answers every read with the template while a queryFn that never resolves is in flight', async () => {
    const hang = neverResolvingQuery();
    const { narrator } = rigWith(hang.fn);
    const started = Date.now();
    for (let n = 0; n < 12; n += 1) {
      const narrated = narrator.get({
        ...merged, facts: { ...merged.facts, pr: 400 + n },
      });
      expect(narrated.glance).toBe(merged.template);
      expect(narrated.detail).toBe(merged.template);
      expect(narrated.narratedAt).toBeNull();
      expect(narrated.raw).toContain('lane: NWR-96');
    }
    expect(Date.now() - started).toBeLessThan(50);
    // The queue really did open sessions; the reads simply never waited for them.
    expect(hang.opened()).toBeGreaterThan(0);
  });
});

describe('one call per distinct fact record', () => {
  it('makes one call for two reads of the same facts, and zero on a second poll', async () => {
    const { narrator, journalPath, published } = rigWith(
      scriptedQuery(() => acceptedReply).fn,
    );
    const first = narrator.get({ ...merged, slice: 'lanes', ref: 'NWR-96' });
    const second = narrator.get({ ...merged, slice: 'lanes', ref: 'NWR-96' });
    expect(first.narratedAt).toBeNull();
    expect(second.narratedAt).toBeNull();
    await narrator.idle();
    expect(narrateCalls(journalPath)).toBe(1);

    const polled = narrator.get({ ...merged, slice: 'lanes', ref: 'NWR-96' });
    expect(polled.glance).toBe('Checks passed and the council approved PR #412.');
    expect(polled.detail).toContain('so NWR-96 is done and ready to merge');
    expect(polled.narratedAt).not.toBeNull();
    await narrator.idle();
    expect(narrateCalls(journalPath)).toBe(1);
    expect(published).toEqual([
      { slice: 'lanes', reason: 'narration landed for lane.did', ref: 'NWR-96' },
    ]);
  });

  it('re-reads the directory on a restart and makes zero calls for known keys', async () => {
    const script = scriptedQuery(() => acceptedReply);
    const first = rigWith(script.fn);
    first.narrator.get(merged);
    await first.narrator.idle();
    expect(narrateCalls(first.journalPath)).toBe(1);

    const restarted = rigWith(script.fn);
    const narrated = restarted.narrator.get(merged);
    expect(narrated.narratedAt).not.toBeNull();
    expect(narrated.glance).toBe('Checks passed and the council approved PR #412.');
    await restarted.narrator.idle();
    expect(narrateCalls(restarted.journalPath)).toBe(1);
    expect(restarted.narrator.cacheSize()).toBe(1);
  });
});

describe('a rejected narration is not paid for twice', () => {
  it('serves the template, journals the rule and never calls again', async () => {
    const leaked = JSON.stringify({
      glance: 'Run S-81782ab668cbbbb3 merged PR #412.',
      detail: 'Every check on PR #412 passed and the council approved it, so NWR-96 is done and ready to merge.',
    });
    const { narrator, journalPath } = rigWith(scriptedQuery(() => leaked).fn);
    narrator.get(merged);
    await narrator.idle();

    const rejected = rows(journalPath).filter((row) => row['event'] === 'narration.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.['rule']).toBe('machine-id');
    expect(rejected[0]?.['token']).toBe('S-81782ab668cbbbb3');

    const served = narrator.get(merged);
    expect(served.glance).toBe(merged.template);
    expect(served.narratedAt).toBeNull();
    await narrator.idle();
    expect(narrateCalls(journalPath)).toBe(1);
  });
});

describe('the hourly cap', () => {
  it('serves the template for the 301st distinct key in an hour and journals it once', async () => {
    const at = Date.UTC(2026, 8, 9, 9, 0, 0);
    const { narrator, journalPath } = rigWith(scriptedQuery(() => acceptedReply).fn, 8);
    for (let n = 0; n < 300; n += 1) {
      narrator.get({ ...merged, facts: { ...merged.facts, pr: 1000 + n } });
    }
    expect(rows(journalPath).filter((row) => row['event'] === 'narration.capped')).toHaveLength(0);

    const over = narrator.get({ ...merged, facts: { ...merged.facts, pr: 9999 } });
    expect(over.glance).toBe(merged.template);
    expect(over.narratedAt).toBeNull();

    // A second key past the cap does not write a second row: one row per hour says so.
    narrator.get({ ...merged, facts: { ...merged.facts, pr: 9998 } });
    const capped = rows(journalPath).filter((row) => row['event'] === 'narration.capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]?.['maxCallsPerHour']).toBe(300);
    expect(capped[0]?.['servedTemplate']).toBe(true);
    expect(at).toBeGreaterThan(0);
    await narrator.idle();
  }, 60_000);
});

describe('FORGE_NARRATE=off', () => {
  it('serves templates and makes no call at all', async () => {
    process.env['FORGE_NARRATE'] = 'off';
    const hang = neverResolvingQuery();
    const { narrator, journalPath } = rigWith(hang.fn);
    expect(narrator.get(merged).narratedAt).toBeNull();
    await narrator.idle();
    expect(hang.opened()).toBe(0);
    expect(narrateCalls(journalPath)).toBe(0);
  });
});

describe('person-authored text', () => {
  it('passes through with three identical registers and no key of its own', () => {
    const words = 'limit per user or per IP?';
    const narrated = passThrough(words);
    expect(narrated.glance).toBe(words);
    expect(narrated.detail).toBe(words);
    expect(narrated.raw).toBe(words);
    expect(narrated.narratedAt).toBeNull();
  });
});

describe('the cache key', () => {
  it('is the same across polls because nothing in it comes from the clock', () => {
    expect(narrationKey(merged)).toBe(narrationKey({ ...merged, template: 'reworded' }));
  });
});
