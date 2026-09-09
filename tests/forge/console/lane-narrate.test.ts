/**
 * The board tile's `did` line, and the one thing on it nobody may rewrite.
 *
 * `computeDid` sources its first branch from the agent's own `forge.report` -- free text
 * the agent wrote about its own work. The rail already refuses to narrate that: a
 * `forge.report` renders as a `reply`, and `reply` is not in `thread-narrate.ts`'s
 * `NARRATED_TYPES`. The tile did narrate it, so the same report could reach the operator
 * twice in two voices, one of them the model's. The falsifier here is the same negative
 * one the rail uses -- the cache directory and the journal, never the narrator's own
 * account of itself -- plus its positive twin, so this cannot be satisfied by narrating
 * nothing at all.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../../src/adapter/engine.js';
import type { ForgeEvent } from '../../../src/forge/journal.js';
import type { Lane, LanePr } from '../../../src/shared/console-model.js';
import { narratedField } from '../../../src/shared/console-model.js';
import { Journal } from '../../../src/forge/journal.js';
import { reasonerFor } from '../../../src/forge/reasoner-claude.js';
import { Narrator } from '../../../src/forge/console/narrate-store.js';
import { narrateLaneFields } from '../../../src/forge/console/lane-narrate.js';
import { didFrom } from '../../../src/forge/console/laneGlance.js';

let home: string;
let policyPath: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-lane-narrate-'));
  journalPath = join(home, 'fleet.jsonl');
  policyPath = join(home, 'policy.json');
  writeFileSync(policyPath, readFileSync(join(process.cwd(), 'src', 'forge', 'model-policy.json'), 'utf8'), 'utf8');
  delete process.env['FORGE_NARRATE'];
});

/** A `query` that answers anything with a well-formed narration. If the agent's own
 *  words ever reach it, the registers stop matching and the specimen says so. */
function rewritingQuery() {
  let opened = 0;
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    opened += 1;
    const promptIter = params.prompt as AsyncIterable<unknown>;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'lane-fake',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      for await (const _pushed of promptIter) {
        yield {
          type: 'assistant', session_id: 'lane-fake',
          message: {
            model: params.options?.model ?? '',
            content: [{ type: 'text', text: JSON.stringify({ glance: 'Rewritten.', detail: 'Rewritten, at length.' }) }],
            usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
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

function rig() {
  const journal = new Journal(journalPath);
  const query = rewritingQuery();
  const narrator = new Narrator({
    reasoner: reasonerFor('claude', { journal, queryFn: query.fn, cwd: home, policyPath }),
    journal, home, policyPath,
  });
  return { narrator, query };
}

function narrateRows(): number {
  let text = '';
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return 0;
  }
  return text.split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row['event'] === 'reasoner.call' && row['class'] === 'narrate').length;
}

function cacheFiles(): string[] {
  try {
    return readdirSync(join(home, 'narration')).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

function ev(partial: Partial<ForgeEvent> & Pick<ForgeEvent, 'event'>): ForgeEvent {
  return { id: 'e1', seq: 1, at: 0, version: 1, actor: 'worker', ...partial };
}

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: true, since: 0,
    startedAt: 0, endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, did: null, didVerbatim: false, now: '',
    you: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 },
    ...extra,
  };
}

const PR: LanePr = {
  no: 118, url: 'https://github.com/x/y/pull/118', draft: true,
  files: 2, add: 79, del: 12, title: 'add the fee cap',
} as LanePr;

describe('didFrom names who wrote the sentence', () => {
  it('calls the agent\'s own report a report', () => {
    const events: ForgeEvent[] = [ev({ event: 'forge.report', done: 'Wired the retry loop.' })];
    expect(didFrom(events, null)).toEqual({ text: 'Wired the retry loop.', source: 'report' });
  });

  it('calls the PR sentence and the tool digest this server\'s own', () => {
    expect(didFrom([], PR).source).toBe('pr');
    expect(didFrom([ev({ event: 'tool.start', tool: 'Bash' })], null).source).toBe('digest');
  });

  it('has nothing to say, and no author for it, on an empty run', () => {
    expect(didFrom([], null)).toEqual({ text: null, source: null });
  });
});

describe('the agent\'s own report on the board tile', () => {
  it('is byte-identical in all three registers, with no call and no cache write', async () => {
    const { narrator, query } = rig();
    const words = 'Wired the retry loop and pinned the timeout.';
    const row = lane({ did: words, didVerbatim: true, plain: '', you: null });

    narrateLaneFields(row, narrator);
    const narrated = narratedField(row.narration, 'did', row.did ?? '');

    expect(row.did).toBe(words);
    expect(narrated.glance).toBe(words);
    expect(narrated.detail).toBe(words);
    expect(narrated.raw).toBe(words);
    expect(narrated.narratedAt).toBeNull();

    await narrator.idle();
    expect(query.opened()).toBe(0);
    expect(narrateRows()).toBe(0);
    expect(cacheFiles()).toEqual([]);
    expect(narrator.cacheSize()).toBe(0);
  });

  it("is still the agent's own words on the poll after the queue drained", async () => {
    // The tile is re-narrated on every read. A `verbatim` field must never acquire a
    // `narratedAt`, however many polls go by -- that stamp is what the console reads to
    // decide a sentence came from the model.
    const { narrator, query } = rig();
    const words = 'Wired the retry loop and pinned the timeout.';
    const row = lane({ did: words, didVerbatim: true });
    narrateLaneFields(row, narrator);
    await narrator.idle();
    narrateLaneFields(row, narrator);
    await narrator.idle();
    expect(row.did).toBe(words);
    expect(narratedField(row.narration, 'did', row.did ?? '').narratedAt).toBeNull();
    expect(query.opened()).toBe(0);
    expect(narrateRows()).toBe(0);
  });
});

describe('the sentences this server composed itself', () => {
  it('narrates a PR-sourced did, so the fix did not simply turn the narrator off', async () => {
    const { narrator, query } = rig();
    const composed = didFrom([], PR);
    expect(composed.source).toBe('pr');
    const row = lane({ did: composed.text, didVerbatim: false, pr: PR });

    // The first read answers from the template, always.
    narrateLaneFields(row, narrator);
    expect(row.did).toBe(composed.text);

    await narrator.idle();
    expect(query.opened()).toBeGreaterThan(0);
    expect(narrateRows()).toBeGreaterThan(0);
    expect(cacheFiles().length).toBeGreaterThan(0);
  });
});
