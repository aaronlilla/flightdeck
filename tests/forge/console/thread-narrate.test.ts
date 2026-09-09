/**
 * The rail, where most of what is on screen is somebody's own words.
 *
 * An operator row is what Aaron typed. A reply is what the agent wrote back. Narrating
 * either would be rewriting a person, so the interesting claim here is a negative one:
 * those rows come out of the narrator with three byte-identical registers, having written
 * nothing to the cache and having made no call. The falsifier is the cache directory and
 * the journal, not the narrator's own account of itself.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../../src/adapter/engine.js';
import type { Message, MessageType } from '../../../src/shared/console-model.js';
import { narratedField } from '../../../src/shared/console-model.js';
import { Journal } from '../../../src/forge/journal.js';
import { reasonerFor } from '../../../src/forge/reasoner-claude.js';
import { Narrator } from '../../../src/forge/console/narrate-store.js';
import { narrateThread } from '../../../src/forge/console/thread-narrate.js';

let home: string;
let policyPath: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-rail-narrate-'));
  journalPath = join(home, 'fleet.jsonl');
  policyPath = join(home, 'policy.json');
  writeFileSync(policyPath, readFileSync(join(process.cwd(), 'src', 'forge', 'model-policy.json'), 'utf8'), 'utf8');
  delete process.env['FORGE_NARRATE'];
});

/** A `query` that answers anything with a well-formed narration. If a person's words ever
 *  reach it, the registers stop matching and the specimen says so. */
function rewritingQuery() {
  let opened = 0;
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    opened += 1;
    const promptIter = params.prompt as AsyncIterable<unknown>;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'rail-fake',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      for await (const _pushed of promptIter) {
        yield {
          type: 'assistant', session_id: 'rail-fake',
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

function message(type: MessageType, text: string): Message {
  return { k: `${type}-1`, type, text, ts: 1_788_000_000_000, source: type === 'operator' ? 'operator' : 'lane-a' };
}

/** Every row type that is a person or the agent speaking. None of them may be narrated. */
const VERBATIM: MessageType[] = ['operator', 'reply', 'question', 'plan', 'confirm', 'blocker', 'decision', 'pr'];

describe('a person\'s own words on the rail', () => {
  for (const type of VERBATIM) {
    it(`leaves a ${type} row byte-identical in all three registers, with no call and no cache write`, async () => {
      const { narrator, query } = rig();
      const words = 'limit per user or per IP?';
      const [row] = narrateThread([message(type, words)], narrator);
      const narrated = narratedField(row?.narration, 'text', row?.text ?? '');

      expect(row?.text).toBe(words);
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
  }
});

describe('the rows this repo wrote itself', () => {
  it('narrates an event row, and lands it on the lanes slice rather than a rail slice', async () => {
    const { narrator, query } = rig();
    const [row] = narrateThread([message('event', 'Started on Sonnet at 09:15.')], narrator);
    // The first read answers from the template, always.
    expect(narratedField(row?.narration, 'text', row?.text ?? '').glance).toBe('Started on Sonnet at 09:15.');

    await narrator.idle();
    expect(query.opened()).toBe(1);
    expect(narrateRows()).toBe(1);
    expect(cacheFiles()).toHaveLength(1);

    const [polled] = narrateThread([message('event', 'Started on Sonnet at 09:15.')], narrator);
    // The reply above changed 09:15, so the checker refused it and the template stands.
    expect(polled?.text).toBe('Started on Sonnet at 09:15.');
    await narrator.idle();
    expect(narrateRows()).toBe(1);
  });

  it('makes no call for a row with nothing in it', async () => {
    const { narrator, query } = rig();
    narrateThread([message('activity', '   ')], narrator);
    await narrator.idle();
    expect(query.opened()).toBe(0);
    expect(narrateRows()).toBe(0);
  });
});
