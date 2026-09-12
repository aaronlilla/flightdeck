/**
 * The conflict check, judged by the model instead of by regexes.
 *
 * The version this replaces matched two hardcoded patterns against the answer text. It
 * caught exactly one conflict in one phrasing -- its own docblock conceded it "will not
 * catch a differently-worded version of the same conflict" -- and it needed two review
 * fixes for false positives before it ever shipped (negation blindness, then a bare `no`
 * matching inside "nothing" and "know").
 *
 * A model already reads every collected decision immediately before the brief is written
 * (`buildBriefPrompt`, one reasoner call that already happens). So the judgement moves
 * there and the code keeps only what it is good at: spotting the signal and holding the
 * item. The plumbing around that -- raising the ask, carrying answers forward, never
 * re-raising -- is unchanged and still covered by `queue-interview.test.ts`.
 *
 * The specimen that matters most is the LAST one: a brief that merely discusses a
 * contradiction must not be mistaken for the signal. A sentinel a model can emit by
 * accident is worse than no sentinel.
 */
import { describe, it, expect } from 'vitest';
import { buildBriefPrompt, readConflictSignal, CONFLICT_SENTINEL } from '../../../src/forge/intake/interview.ts';
import type { Packet } from '../../../src/forge/contracts.ts';

const PACKET = {
  id: 'p1', ticket: 'ACME-1', what: 'a drop-down dismisses itself', where: 'jira',
  evidence: [], confidence: 'low', repo: 'acme/acme-app', blockedBy: [], at: 0,
} as unknown as Packet;

describe('buildBriefPrompt asks the model to judge the decisions it is given', () => {
  it('tells it to stop and ask rather than write a brief over a conflict', () => {
    const prompt = buildBriefPrompt(PACKET, [
      { question: 'where does dismissal live?', answer: 'in the shared component', answeredBy: 'aaron' },
    ]);
    // Asserted as whole instructions, not as scattered words. Checking for the fragments
    // separately let two of these lines be deleted with every assertion still passing
    // (falsifier run, 2026-09-12).
    const flat = prompt.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('read the settled answers against each other');
    expect(flat).toContain('impossible to satisfy at the same time');
    expect(flat).toContain('if two are incompatible, write no brief');
    expect(flat).toContain(`first line is \`${CONFLICT_SENTINEL.toLowerCase()}:`);
    expect(flat).toContain('nothing may come before that first line');
    // And the other half: most tickets have no conflict, so it must be told not to hunt.
    expect(flat).toContain('holding one on an imagined conflict costs more than it saves');
  });

  it('still carries the settled decisions and the brief instructions', () => {
    const prompt = buildBriefPrompt(PACKET, [
      { question: 'where does dismissal live?', answer: 'in the shared component', answeredBy: 'aaron' },
    ]);
    expect(prompt).toContain('where does dismissal live?');
    expect(prompt).toContain('in the shared component');
    expect(prompt).toContain('## Decisions');
  });
});

describe('readConflictSignal', () => {
  it('reads the question and options out of a conflict reply', () => {
    const signal = readConflictSignal(
      `${CONFLICT_SENTINEL}: Decisions 1 and 3 cannot both hold. A backdrop inside the shared `
      + 'component swallows the tap it closes on. Which do you want?\n'
      + 'OPTIONS: keep it in the component and accept a second tap | move the listener above the component',
    );
    expect(signal).not.toBeNull();
    expect(signal?.question).toContain('Decisions 1 and 3 cannot both hold');
    expect(signal?.options).toEqual([
      'keep it in the component and accept a second tap',
      'move the listener above the component',
    ]);
  });

  it('answers null for an ordinary brief', () => {
    expect(readConflictSignal('# Goal: stop the drop-down dismissing itself\n\nDo the thing.')).toBeNull();
  });

  // The false positive that would matter. A brief is allowed to use the word, and a
  // sentinel that fires from the middle of a document holds work on a sentence.
  it('answers null when the brief merely discusses a contradiction further down', () => {
    const brief = `# Goal: stop the drop-down dismissing itself\n\n`
      + `The earlier ticket had a ${CONFLICT_SENTINEL}: between two decisions, which is why this\n`
      + 'one states the tap behaviour up front.\n\nOPTIONS: none | none';
    expect(readConflictSignal(brief)).toBeNull();
  });

  it('answers null when the signal carries no question text', () => {
    expect(readConflictSignal(`${CONFLICT_SENTINEL}:   \nOPTIONS: a | b`)).toBeNull();
  });

  it('reads a signal with no options line, rather than dropping it', () => {
    const signal = readConflictSignal(`${CONFLICT_SENTINEL}: these two cannot both hold, which do you want?`);
    expect(signal?.question).toContain('cannot both hold');
    expect(signal?.options).toEqual([]);
  });

  it('ignores leading blank lines and surrounding whitespace', () => {
    const signal = readConflictSignal(`\n\n  ${CONFLICT_SENTINEL}: two decisions collide here.\n  OPTIONS: a | b `);
    expect(signal?.question).toBe('two decisions collide here.');
    expect(signal?.options).toEqual(['a', 'b']);
  });

  it('drops empty option fragments rather than offering a blank choice', () => {
    const signal = readConflictSignal(`${CONFLICT_SENTINEL}: pick one.\nOPTIONS: a |  | b |`);
    expect(signal?.options).toEqual(['a', 'b']);
  });
});
