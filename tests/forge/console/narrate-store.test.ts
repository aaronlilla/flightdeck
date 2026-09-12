/**
 * The cache and the queue behind it: the half where "narrated" can read Met while every
 * board in the fleet is quietly showing a template, or while every poll pays for the same
 * sentence again.
 *
 * No model is called here. Every specimen injects a fake `queryFn` through the same
 * `reasonerFor('claude', ...)` seam the server wires in production -- the narrator itself
 * is never faked, because a fake narrator would prove only that the fake works.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../../src/adapter/engine.js';
import type { NarrationFacts } from '../../../src/shared/console-model.js';
import type { SliceName } from '../../../src/shared/console-events.js';
import { Journal } from '../../../src/forge/journal.js';
import { reasonerFor } from '../../../src/forge/reasoner-claude.js';
import { VolatileFactError, narrationKey } from '../../../src/forge/console/narrate.js';
import type { NarrationEntry } from '../../../src/forge/console/narrate-store.js';
import {
  CACHE_MAX_ENTRIES, NarrationStore, Narrator, passThrough,
} from '../../../src/forge/console/narrate-store.js';

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
    // The bound was 50ms and it failed the full suite at 51ms on a loaded box, which
    // measured this machine rather than the code. What the falsifier is actually about is
    // whether a read waits on a call: the query here never resolves, so a route that
    // awaited it would sit until the class timeout (60s in the shipped policy) or forever.
    // Two seconds is still an order of magnitude inside that and cannot be reached by
    // twelve cache misses that only enqueue.
    expect(Date.now() - started).toBeLessThan(2_000);
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

/**
 * The break measured on the live console 2026-09-11: one ticket drove 164 narration
 * calls between 13:45 and 16:10, 9,995 seconds of model time, because the sentence
 * `laneGlance.ts` builds off a running tool tally reads "Ran 2 commands.", then "Ran 3
 * commands.", then "Ran 4 commands." on the very next poll. A first version of this fix
 * flattened every digit in a template unconditionally, and a review round the same day
 * found what that broke: `queue-route.ts`'s `queueOrderWordsWith` writes a queue card's
 * own position straight into its template with no fact behind it either ("9th in the
 * queue..."), and a blind flatten cannot tell that digit apart from the tally noise it
 * was built to catch -- the ninth card and the fourth card hashed the same key and one
 * served the other's sentence. `narrationKey` now only flattens a template digit that a
 * fact already carries (`mirroredDigits`), which fixes the collision unconditionally but
 * means the tally itself is not deduped here: `didFactsFor` never mirrors it into facts,
 * so this file alone does not close the original storm. That is finishing work for
 * whoever owns `laneGlance.ts` next, not a gap in this file's own guarantee.
 */
describe('narrationKey never guesses which of a template\'s own digits are safe to fold', () => {
  it('does not collapse two queue cards whose only difference is a position no fact carries', () => {
    // The exact shape `queueOrderWordsWith` writes past the third position: `facts` has
    // `source` and nothing else, and the ordinal plus the queued-at clock live only in
    // the template. This is the specimen the review round asked for.
    const fourth: NarrationFacts = {
      surface: 'queue.whyNext', facts: { source: 'a ticket in Ready for Dev' },
      template: '4th in the queue, from a ticket in Ready for Dev; queued 09:15 UTC.',
    };
    const ninth: NarrationFacts = {
      surface: 'queue.whyNext', facts: { source: 'a ticket in Ready for Dev' },
      template: '9th in the queue, from a ticket in Ready for Dev; queued 09:16 UTC.',
    };
    expect(narrationKey(fourth)).not.toBe(narrationKey(ninth));
  });

  it('does not collapse a run of polls whose tally is not mirrored anywhere in facts', async () => {
    // The known gap, named rather than hidden: without a fact behind the tally, the
    // safe key cannot tell "the same work, one command later" from "a different card
    // that happens to end in a digit," so it makes a call each time, same as before this
    // fix -- closing this fully is `laneGlance.ts`'s to do (finishing work).
    const { narrator, journalPath } = rigWith(scriptedQuery(() => acceptedReply).fn);
    const base: NarrationFacts = {
      surface: 'lane.did', facts: { lane: 'BBZ-169', state: 'running' }, template: 'Ran 2 commands.',
    };
    for (const template of ['Ran 2 commands.', 'Ran 3 commands.', 'Ran 4 commands.', 'Ran 5 commands.']) {
      narrator.get({ ...base, template });
    }
    await narrator.idle();
    expect(narrateCalls(journalPath)).toBe(4);
  });

  it('folds a template digit into one key once a fact actually carries it', async () => {
    // The positive case: two different facts each mirror one of the two numbers this
    // template could show ("2" from a first attempt, "3" from a second), so both
    // renderings of it are individually vouched for and collapse to one call -- proving
    // the mechanism works for a caller that does mirror what it wants ignored, which is
    // the fix this file promises, distinct from the gap named above.
    const { narrator, journalPath } = rigWith(scriptedQuery(() => acceptedReply).fn);
    const facts = { lane: 'BBZ-169', firstAttempt: 2, secondAttempt: 3 };
    narrator.get({ surface: 'lane.did', facts, template: 'Ran 2 commands.' });
    narrator.get({ surface: 'lane.did', facts, template: 'Ran 3 commands.' });
    await narrator.idle();
    expect(narrateCalls(journalPath)).toBe(1);
  });

  it('still narrates again when the ticket, not just an un-mirrored digit, actually changes', async () => {
    const { narrator, journalPath } = rigWith(scriptedQuery(() => acceptedReply).fn);
    narrator.get({ surface: 'lane.did', facts: { lane: 'BBZ-169', state: 'running' }, template: 'Ran 2 commands.' });
    narrator.get({ surface: 'lane.did', facts: { lane: 'BBZ-201', state: 'running' }, template: 'Ran 2 commands.' });
    await narrator.idle();
    expect(narrateCalls(journalPath)).toBe(2);
  });

  it('journals a fold once an hour so a collapsed poll is visible, not silent', async () => {
    // Same mirrored-digit setup as the positive case above: both attempts are
    // individually vouched for by a fact, so the second poll's raw template drifts from
    // the entry the (now-shared) key matched, and that drift gets one journal row.
    const matchingReply = JSON.stringify({
      glance: 'Ran 2 commands.', detail: 'BBZ-169 is running: attempt 2 first, attempt 3 second.',
    });
    const { narrator, journalPath } = rigWith(scriptedQuery(() => matchingReply).fn);
    const facts = { lane: 'BBZ-169', state: 'running', firstAttempt: 2, secondAttempt: 3 };
    narrator.get({ surface: 'lane.did', facts, template: 'Ran 2 commands.' });
    await narrator.idle();
    narrator.get({ surface: 'lane.did', facts, template: 'Ran 3 commands.' });
    narrator.get({ surface: 'lane.did', facts, template: 'Ran 3 commands.' });
    const deduped = rows(journalPath).filter((row) => row['event'] === 'narration.deduped');
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.['surface']).toBe('lane.did');
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

/** A fake `query` that dies mid-session the first `failures` times it is opened, then
 *  answers normally. A dropped socket, a killed subprocess, a model that 500s. */
function failingQuery(failures: number, reply: string) {
  let opened = 0;
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    opened += 1;
    const failThis = opened <= failures;
    const promptIter = params.prompt as AsyncIterable<unknown>;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'narrate-fail',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      if (failThis) throw new Error('the model session dropped');
      for await (const _pushed of promptIter) {
        yield {
          type: 'assistant', session_id: 'narrate-fail',
          message: {
            model: params.options?.model ?? '',
            content: [{ type: 'text', text: reply }],
            usage: {
              input_tokens: 10, cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0, output_tokens: 5,
            },
          },
        };
        yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 };
        return;
      }
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn, opened: () => opened };
}

describe('a call that failed in transport is not paid for twice', () => {
  it('serves the template, journals the failure, and makes zero calls on the next poll', async () => {
    const dropped = failingQuery(1, acceptedReply);
    const { narrator, journalPath } = rigWith(dropped.fn);
    narrator.get(merged);
    await narrator.idle();

    const failed = rows(journalPath).filter((row) => row['event'] === 'narration.failed');
    expect(failed).toHaveLength(1);
    const before = narrateCalls(journalPath);
    expect(before).toBe(1);

    const served = narrator.get(merged);
    expect(served.glance).toBe(merged.template);
    expect(served.detail).toBe(merged.template);
    expect(served.narratedAt).toBeNull();
    await narrator.idle();
    expect(narrateCalls(journalPath)).toBe(before);
    expect(dropped.opened()).toBe(1);
  });

  it('lets a restart try once more, so a bad ten minutes is not a permanent template', async () => {
    const dropped = failingQuery(1, acceptedReply);
    const first = rigWith(dropped.fn);
    first.narrator.get(merged);
    await first.narrator.idle();
    expect(narrateCalls(first.journalPath)).toBe(1);

    const restarted = rigWith(dropped.fn);
    expect(restarted.narrator.cacheSize()).toBe(0);
    expect(restarted.narrator.get(merged).narratedAt).toBeNull();
    await restarted.narrator.idle();
    expect(narrateCalls(restarted.journalPath)).toBe(2);
    // Second time the call came back, so the sentence is there and stays there.
    const polled = restarted.narrator.get(merged);
    expect(polled.glance).toBe('Checks passed and the council approved PR #412.');
    expect(polled.narratedAt).not.toBeNull();
  });

  it('does not re-try a narration the checker refused, which is about the facts', async () => {
    const leaked = JSON.stringify({
      glance: 'Run S-81782ab668cbbbb3 merged PR #412.',
      detail: 'Every check on PR #412 passed and the council approved it, so NWR-96 is done and ready to merge.',
    });
    const first = rigWith(scriptedQuery(() => leaked).fn);
    first.narrator.get(merged);
    await first.narrator.idle();

    const restarted = rigWith(scriptedQuery(() => leaked).fn);
    expect(restarted.narrator.cacheSize()).toBe(1);
    expect(restarted.narrator.get(merged).glance).toBe(merged.template);
    await restarted.narrator.idle();
    expect(narrateCalls(restarted.journalPath)).toBe(1);
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

describe('a policy that declares no narrate class', () => {
  it('narrates nothing, calls nothing and throws nothing', async () => {
    const bare = join(home, 'bare-policy.json');
    writeFileSync(bare, JSON.stringify({ version: 1, classes: {} }), 'utf8');
    const journalPath = join(home, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    const hang = neverResolvingQuery();
    const narrator = new Narrator({
      reasoner: reasonerFor('claude', { journal, queryFn: hang.fn, cwd: home, policyPath: bare }),
      journal, home, policyPath: bare,
    });
    const narrated = narrator.get(merged);
    expect(narrated.glance).toBe(merged.template);
    expect(narrated.narratedAt).toBeNull();
    await narrator.idle();
    expect(hang.opened()).toBe(0);
    expect(narrateCalls(journalPath)).toBe(0);
    expect(narrator.cacheSize()).toBe(0);
  });
});

describe('the cache key', () => {
  it('is the same across polls because nothing in it comes from the clock', () => {
    const first = narrationKey(merged);
    const start = Date.now();
    while (Date.now() === start) { /* spin until the wall clock has actually moved */ }
    expect(Date.now()).toBeGreaterThan(start);
    expect(narrationKey(merged)).toBe(first);
    // And the clock cannot get in by the front door either: a fact record carrying one
    // is refused rather than hashed.
    expect(() => narrationKey({ ...merged, facts: { ...merged.facts, now: Date.now() } as never }))
      .toThrow(VolatileFactError);
  });

  it('is not the same when the sentence being replaced says something else', () => {
    expect(narrationKey(merged)).not.toBe(narrationKey({ ...merged, template: 'reworded' }));
  });
});

describe('what a critique of the cache asked it to survive', () => {
  /** One cache entry, valid enough to be indexed and re-read. */
  function entry(key: string, narratedAt: number) {
    return {
      key, input: merged, glance: 'Checks passed.', detail: 'Every check passed.',
      narratedAt, model: 'claude-sonnet-5',
      verdict: { ok: true, token: null, register: null, rule: null, reason: 'accepted' },
    } satisfies NarrationEntry;
  }

  it('leaves no .tmp file behind, and never lets two writers share one tmp name', () => {
    // `${final}.tmp` was a fixed name. Two processes on one FORGE_HOME -- the console and
    // `scripts/narrate-proof.ts`, which is how the live proof is actually run -- could be
    // inside `writeFileSync` for the same key at once, and the loser's rename published
    // the winner's half-written bytes under a name the next boot trusts.
    const store = new NarrationStore(home);
    store.put(entry('aaa', 1_000));
    store.put(entry('bbb', 2_000));
    const left = readdirSync(join(home, 'narration'));
    expect(left.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(left.sort()).toEqual(['aaa.json', 'bbb.json']);
  });

  it('keeps the newest entries and drops the oldest once the cache is over its ceiling', () => {
    // One file per distinct fact record, forever, and `load()` reads every one of them at
    // boot. At the policy's own 300 calls an hour that is a quarter of a million files a
    // month on a fleet nobody is watching.
    // The shipped ceiling is CACHE_MAX_ENTRIES; the store takes a smaller one so this
    // specimen proves the sweep in milliseconds instead of writing twenty thousand files.
    expect(CACHE_MAX_ENTRIES).toBeGreaterThan(1_000);
    const ceiling = 40;
    const store = new NarrationStore(home, ceiling);
    const over = ceiling + 20;
    for (let index = 0; index < over; index += 1) {
      store.put(entry(`k${String(index).padStart(6, '0')}`, 1_000 + index));
    }
    expect(store.size()).toBeLessThanOrEqual(ceiling);
    expect(readdirSync(join(home, 'narration')).length).toBeLessThanOrEqual(ceiling);

    // The survivors are the newest, so the boards being read right now keep their sentences.
    const reopened = new NarrationStore(home, ceiling);
    expect(reopened.size()).toBeLessThanOrEqual(ceiling);
    expect(reopened.has(`k${String(over - 1).padStart(6, '0')}`)).toBe(true);
    expect(reopened.has('k000000')).toBe(false);
  });

  it('still counts an hour of calls against the cap after a restart', async () => {
    // The cap is spend control and it lived in one process's memory. Every flightdeck
    // cutover restarts the console, so an unattended fleet could buy the whole cap again
    // each time -- the one thing `maxCallsPerHour` exists to make impossible.
    const source = join(process.cwd(), 'src', 'forge', 'model-policy.json');
    const policy = JSON.parse(readFileSync(source, 'utf8')) as {
      classes: Record<string, Record<string, unknown>>;
    };
    policy.classes['narrate'] = { ...policy.classes['narrate'], maxCallsPerHour: 2 };
    writeFileSync(policyPath, JSON.stringify(policy), 'utf8');

    const first = rigWith(scriptedQuery(() => acceptedReply).fn, 1);
    for (let n = 0; n < 2; n += 1) first.narrator.get({ ...merged, facts: { ...merged.facts, pr: 700 + n } });
    await first.narrator.idle();
    expect(narrateCalls(first.journalPath)).toBe(2);

    const second = rigWith(scriptedQuery(() => acceptedReply).fn, 1);
    const served = second.narrator.get({ ...merged, facts: { ...merged.facts, pr: 999 } });
    await second.narrator.idle();
    expect(served.glance).toBe(merged.template);
    expect(narrateCalls(second.journalPath)).toBe(2);
  }, 30_000);
});
