import { describe, expect, it } from 'vitest';

import { humanizeParkReason, oneSentence, TILE_SENTENCE_LIMIT } from '../../src/shared/humanize.js';
import { plainStatus } from '../../src/forge/console/plain.js';
import type { Lane } from '../../src/shared/console-model.js';

/**
 * What a board tile is allowed to say.
 *
 * A park reason is written once by whatever stopped the run and replayed on the tile for
 * as long as the lane is there, so one bad line stays on screen for days. This was on the
 * live board on 2026-09-13, 250 characters of it, wrapped over the card:
 *
 *   Stuck since today: drift confirmed off-brief: The transcript tail is empty/contains
 *   no actual tool calls or edits shown, giving no evidence the agent did any work on the
 *   BBZ-289 queue row title fix or the specified branch/verification steps..
 *
 * Three faults in one line: a term nobody outside the machine uses, a paragraph where the
 * card has room for a sentence, and two full stops. The repository's own copy rule reads
 * source literals, and this text is data, so nothing was looking at it.
 */
const REAL = 'drift confirmed off-brief: The transcript tail is empty/contains no actual '
  + 'tool calls or edits shown, giving no evidence the agent did any work on the BBZ-289 '
  + 'queue row title fix or the specified branch/verification steps..';

describe('the reason a tile shows', () => {
  it('fits on the card', () => {
    expect(humanizeParkReason(REAL).length).toBeLessThanOrEqual(TILE_SENTENCE_LIMIT + 1);
  });

  it('carries no word that belongs to the machine', () => {
    const said = humanizeParkReason(REAL);
    for (const word of ['drift', 'off-brief', 'transcript', 'the agent']) {
      expect(said.toLowerCase(), `"${said}" still says ${word}`).not.toContain(word);
    }
  });

  it('says what happened, rather than dropping the meaning to get short', () => {
    expect(humanizeParkReason(REAL)).toMatch(/went off the brief/i);
  });

  it('ends once', () => {
    expect(humanizeParkReason(REAL)).not.toMatch(/\.\.$/);
  });

  it('does not gain a second full stop from the template that frames it', () => {
    // `plainStatus` writes `Stuck since <day>: <reason>`, and a reason that ends its own
    // sentence used to meet the template's own stop.
    const framed = `Stuck since today: ${humanizeParkReason('It stopped.')}`;
    expect(framed).not.toMatch(/\.\./);
  });
});

describe('cutting a reason down to one sentence', () => {
  it('keeps a short one whole, with the full stop it came with', () => {
    expect(oneSentence('It ran out of tokens.')).toBe('It ran out of tokens.');
  });

  it('takes the first sentence and leaves the rest', () => {
    expect(oneSentence('It stopped. Then a second thing. And a third.')).toBe('It stopped.');
  });

  it('cuts a long one at a word, not mid-word', () => {
    const long = `${'alpha '.repeat(60)}omega.`;
    const said = oneSentence(long);
    expect(said.length).toBeLessThanOrEqual(TILE_SENTENCE_LIMIT + 1);
    expect(said.endsWith('…')).toBe(true);
    expect(said, 'it cut a word in half').not.toMatch(/alph…$/);
  });

  it('leaves a reason with no sentence end alone, still capped', () => {
    expect(oneSentence('no full stop anywhere here')).toBe('no full stop anywhere here');
  });

  it('flattens the newlines a multi-line reason arrives with', () => {
    expect(oneSentence('It stopped\n   because the base moved.')).toBe('It stopped because the base moved.');
  });

  it('answers nothing worth reading for an empty reason', () => {
    expect(oneSentence('   ')).toBe('');
    // Punctuation alone is not a sentence; it collapses to one mark and nothing else,
    // which the caller's own fallback replaces.
    expect(oneSentence('...').replace(/[.!?]/g, '')).toBe('');
  });
});

describe('the line that actually lands on the card', () => {
  // The cap used to be measured on the reason, and then "Stuck since today: " was added
  // in front of it -- 137 characters on a card sized for 120, measured on the live board.
  function blocked(reason: string): string {
    const lane = {
      id: 'r-1', state: 'blocked', kind: 'goal', since: Date.parse('2026-09-13T09:00:00Z'),
      reason, pr: null, retiredAt: null, question: null,
    } as unknown as Lane;
    return plainStatus(lane, { now: Date.parse('2026-09-13T12:00:00Z') });
  }

  it('fits, prefix included', () => {
    const said = blocked('a'.repeat(300));
    expect(said.length, said).toBeLessThanOrEqual(TILE_SENTENCE_LIMIT + 2);
  });

  it('still says which day and why', () => {
    const said = blocked('the base moved under it');
    expect(said).toMatch(/Stuck since/);
    expect(said).toMatch(/the base moved under it/);
  });

  it('ends once, whatever the reason brought', () => {
    expect(blocked('it stopped.')).not.toMatch(/\.\./);
    expect(blocked('it stopped')).toMatch(/\.$/);
  });
});
