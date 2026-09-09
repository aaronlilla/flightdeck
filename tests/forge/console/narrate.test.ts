/**
 * The pure half of the narration layer: the cache key, the raw register, the prompt and
 * the reply parser. No model, no disk, no clock.
 */
import { describe, expect, it } from 'vitest';

import type { NarrationFacts } from '../../../src/shared/console-model.js';
import {
  VolatileFactError, assertNarrationFacts, buildNarrationPrompt, canonicalFacts, narrationKey,
  parseNarration, rawFor, templateNarration,
} from '../../../src/forge/console/narrate.js';
import { protectedTokensFor } from '../../../src/forge/console/narrate-checker.js';

const queueFacts: NarrationFacts = {
  surface: 'queue.whyNext',
  facts: { position: 4, source: 'Ready for Dev', waitsFor: 'nwr-233', queuedAt: '09:15' },
  template: '4th in the queue, from a ticket in Ready for Dev. Its brief says to wait for nwr-233.',
};

describe('narrationKey', () => {
  it('hashes the same for identical facts written in a different key order', () => {
    const reordered: NarrationFacts = {
      surface: 'queue.whyNext',
      facts: { queuedAt: '09:15', waitsFor: 'nwr-233', source: 'Ready for Dev', position: 4 },
      template: queueFacts.template,
    };
    expect(narrationKey(reordered)).toBe(narrationKey(queueFacts));
    expect(canonicalFacts(reordered)).toBe(canonicalFacts(queueFacts));
  });

  it('hashes differently when a fact changes', () => {
    const moved: NarrationFacts = {
      ...queueFacts, facts: { ...queueFacts.facts, position: 5 },
    };
    expect(narrationKey(moved)).not.toBe(narrationKey(queueFacts));
  });

  it('hashes differently when the template says something else', () => {
    const reworded: NarrationFacts = { ...queueFacts, template: 'Fourth in line.' };
    expect(narrationKey(reworded)).not.toBe(narrationKey(queueFacts));
  });

  // The falsifier for the collision this key was changed to close: two rail rows that
  // say different things, with no clock time and no PR number between them, so
  // `railFactsFor` gives both an empty fact record. Keyed on facts alone they are one
  // entry, and the first one narrated answers for the other for good.
  it('separates two rail rows whose fact records are both empty', () => {
    const started: NarrationFacts = { surface: 'rail.event', facts: {}, template: 'The run started.' };
    const paused: NarrationFacts = { surface: 'rail.event', facts: {}, template: 'The run paused.' };
    expect(narrationKey(started)).not.toBe(narrationKey(paused));
  });

  it('separates two lane sentences that differ only in the words the agent reported', () => {
    const base: NarrationFacts = { surface: 'lane.did', facts: { lane: 'NWR-96', state: 'running' }, template: 'Wrote the store.' };
    const later: NarrationFacts = { ...base, template: 'Wrote the checker.' };
    expect(narrationKey(later)).not.toBe(narrationKey(base));
  });

  it('separates two narrations whose only difference is the fuller template', () => {
    const short: NarrationFacts = { ...queueFacts, detailTemplate: 'Fourth, and nothing ahead of it waits on you.' };
    expect(narrationKey(short)).not.toBe(narrationKey(queueFacts));
  });
});

describe('volatile facts', () => {
  it('refuses a facts record carrying since or now at runtime', () => {
    for (const key of ['since', 'now', 'elapsed', 'updatedAt']) {
      expect(() => assertNarrationFacts({ [key]: 1 } as never)).toThrow(VolatileFactError);
    }
  });

  it('refuses them through every entry point, not only the assertion', () => {
    const volatile = {
      surface: 'lane.now', facts: { state: 'parked', since: 1_788_000_000_000 },
      template: 'Paused.',
    } as unknown as NarrationFacts;
    expect(() => narrationKey(volatile)).toThrow(VolatileFactError);
    expect(() => rawFor(volatile)).toThrow(VolatileFactError);
  });

  it('refuses them at the type', () => {
    // @ts-expect-error `since` is a volatile fact key and the type says so
    const refused: NarrationFacts = { surface: 'lane.now', facts: { since: 12 }, template: 'x' };
    expect(refused.surface).toBe('lane.now');
  });
});

describe('rawFor', () => {
  it('keeps every identifier verbatim, one key per line, in key order', () => {
    const raw = rawFor({
      surface: 'lane.did',
      facts: { run: 'S-81782ab668cbbbb3', lane: 'NWR-96', pr: 412 },
      template: 'Opened a PR.',
    });
    expect(raw.split('\n')).toEqual([
      'surface: lane.did', 'lane: NWR-96', 'pr: 412', 'run: S-81782ab668cbbbb3',
    ]);
  });
});

describe('templateNarration', () => {
  it('serves the template in both sentence registers with narratedAt null', () => {
    const narrated = templateNarration(queueFacts);
    expect(narrated.glance).toBe(queueFacts.template);
    expect(narrated.detail).toBe(queueFacts.template);
    expect(narrated.narratedAt).toBeNull();
    expect(narrated.raw).toContain('position: 4');
  });

  it('uses detailTemplate for detail when the builder gave one', () => {
    const narrated = templateNarration({ ...queueFacts, detailTemplate: 'It waits for nwr-233.' });
    expect(narrated.detail).toBe('It waits for nwr-233.');
  });
});

describe('buildNarrationPrompt', () => {
  it('names every protected token', () => {
    const tokens = protectedTokensFor(queueFacts);
    const prompt = buildNarrationPrompt(queueFacts, tokens);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) expect(prompt).toContain(token);
  });

  it('carries the register rules, the machine-id rule and the facts', () => {
    const prompt = buildNarrationPrompt(queueFacts, protectedTokensFor(queueFacts));
    expect(prompt).toContain('PROTECTED TOKENS');
    expect(prompt).toContain('run id');
    expect(prompt).toContain('glance');
    expect(prompt).toContain('detail');
    expect(prompt).toContain('waitsFor: nwr-233');
  });
});

describe('parseNarration', () => {
  const expected = { glance: 'Merged.', detail: 'PR #412 merged and the slot picked up the next ticket.' };

  it('accepts a bare object', () => {
    expect(parseNarration(JSON.stringify(expected))).toEqual(expected);
  });

  it('accepts a fenced object', () => {
    expect(parseNarration(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``)).toEqual(expected);
  });

  it('accepts the object inside the reasoner text wrapper', () => {
    expect(parseNarration(JSON.stringify({ text: JSON.stringify(expected) }))).toEqual(expected);
  });

  it('accepts a fenced object inside the text wrapper', () => {
    const wrapped = JSON.stringify({ text: `\`\`\`\n${JSON.stringify(expected)}\n\`\`\`` });
    expect(parseNarration(wrapped)).toEqual(expected);
  });

  it('returns null rather than guessing at anything else', () => {
    expect(parseNarration('Merged.')).toBeNull();
    expect(parseNarration('')).toBeNull();
    expect(parseNarration(JSON.stringify({ glance: 'Merged.' }))).toBeNull();
    expect(parseNarration(JSON.stringify(['Merged.']))).toBeNull();
  });
});
