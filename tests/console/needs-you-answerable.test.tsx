import { describe, expect, it } from 'vitest';

import { answerable, buildNeeds, type Need } from '../../src/console/components/NeedsYou.js';
import type { Lane, Message } from '../../src/shared/console-model.js';

/**
 * The strip puts the next thing a person can answer in front of them.
 *
 * The escape, measured live on 2026-09-12: 67 confirm cards on the strip, every title
 * the literal string `confirm?`, every body the same string, every "Why it is asking"
 * empty, and all 67 ranked ahead of the real questions because the sort key was the
 * card's kind. Aaron: "the UI is totally worthless, how am i going to answer questions
 * when they look like this".
 *
 * Two behaviours are covered here and they are separable. A card that carries words
 * shows them rather than its fallback. And a card nobody can answer never sits in front
 * of one somebody can.
 */

const NOW = 1_789_200_000_000;

function confirmCard(k: string, patch: Partial<Message> = {}): Message {
  return {
    k, type: 'confirm', text: 'confirm?', ts: NOW - 60_000, source: 'conductor',
    btns: [{ label: 'Confirm', cmd: `confirm ${k}` }, { label: 'Not now', cmd: `dismiss ${k}` }],
    ...patch,
  };
}

function laneWithQuestion(id: string, askedAt: number): Lane {
  return {
    id, title: 'Wallet home screen', ticket: 'BBZ-169', state: 'blocked',
    stepN: 3, stepTotal: 7, stepText: 'waiting on an answer', since: askedAt,
    retiredAt: null, reason: null, plain: null, pr: null,
    question: { key: 'k1', text: 'Build it here, or hold until BB-86 lands?', opts: ['Build it here', 'Hold'], askedAt, recommended: 0 },
  } as unknown as Lane;
}

describe('a confirm card shows what the click will do', () => {
  it('reads the blast rather than the fallback constant', () => {
    const [need] = buildNeeds([], [confirmCard('c1', { blast: 'BBZ-182 is killed immediately; its worktree and process are gone' })]);
    expect(need?.line).toBe('BBZ-182 is killed immediately; its worktree and process are gone');
    expect(need?.title).not.toBe('confirm?');
  });

  it('falls back to the card text when there is nothing else to show', () => {
    const [need] = buildNeeds([], [confirmCard('c1')]);
    expect(need?.line).toBe('confirm?');
  });
});

describe('answerable', () => {
  const base: Need = {
    kind: 'confirm', uid: 'u', id: 'l', key: '', title: 'Confirm', line: 'Kill BBZ-182?',
    options: [{ label: 'Confirm', cmd: 'confirm t' }], askKey: 'k', askedAt: NOW,
    evidence: [], passedTo: null, passedAt: null, answeredBy: null, passable: false,
  };

  it('is true for a card with words and a way to reply', () => {
    expect(answerable(base)).toBe(true);
  });

  it('is false when every line it carries is the fallback constant', () => {
    expect(answerable({ ...base, title: 'confirm?', line: 'confirm?', evidence: ['confirm?'] })).toBe(false);
  });

  it('is false when there is nothing to click', () => {
    expect(answerable({ ...base, options: [] })).toBe(false);
  });

  it('is true when the words are only in the evidence', () => {
    expect(answerable({ ...base, title: 'confirm?', line: 'confirm?', evidence: ['BBZ-182 is killed immediately'] })).toBe(true);
  });
});

describe('the strip ranks answerable first', () => {
  it('puts a real question ahead of a contentless confirm, whatever their kinds say', () => {
    const needs = buildNeeds(
      [laneWithQuestion('lane-1', NOW - 10_000)],
      [confirmCard('dead', { text: 'confirm?', ts: NOW - 500_000 })],
    );
    expect(needs).toHaveLength(2);
    expect(needs[0]?.kind).toBe('lane');
    expect(needs[0]?.line).toContain('Build it here');
    expect(needs[1]?.line).toBe('confirm?');
  });

  it('keeps worst-first between two cards a person can answer', () => {
    const needs = buildNeeds(
      [laneWithQuestion('lane-1', NOW - 900_000)],
      [confirmCard('live', { blast: 'BBZ-182 is killed immediately', ts: NOW - 10_000 })],
    );
    // Both answerable, so kind decides: a confirm outranks a lane question.
    expect(needs[0]?.kind).toBe('confirm');
  });

  it('keeps oldest-first between two cards of one kind', () => {
    const needs = buildNeeds([], [
      confirmCard('newer', { blast: 'Newer blast', ts: NOW - 10_000 }),
      confirmCard('older', { blast: 'Older blast', ts: NOW - 900_000 }),
    ]);
    expect(needs.map((need) => need.line)).toEqual(['Older blast', 'Newer blast']);
  });

  it('drops a confirm the server already settled as expired', () => {
    expect(buildNeeds([], [confirmCard('c1', { resolved: 'expired' })])).toEqual([]);
  });
});

/**
 * Every open question reaches the console as a `question` card on the thread response's
 * card list. The strip took `blocker` and `confirm` cards only, so all 92 open questions
 * on the live console were dropped: the one surface whose job is to say what needs a
 * person was the one surface that never showed a question (measured 2026-09-12).
 */
describe('open questions reach the strip', () => {
  function questionCard(key: string, patch: Partial<Message> = {}): Message {
    return {
      k: `question-${key}`, type: 'question', text: 'Build it here, or hold until BB-86 lands?',
      ts: NOW - 60_000, source: 'item:Q-fc2090a8', askKey: key,
      opts: ['Build it here', 'Hold'], recommended: 0, optionSource: 'drafted',
      ...patch,
    };
  }

  it('renders a question card as something to answer', () => {
    const [need] = buildNeeds([], [questionCard('k1')]);
    expect(need?.kind).toBe('question');
    expect(need?.line).toContain('Build it here');
    expect(need?.options.map((option) => option.label)).toEqual(['Build it here', 'Hold']);
  });

  it('posts the answer against the ask key, not the card key', () => {
    const [need] = buildNeeds([], [questionCard('k1')]);
    expect(need?.options[0]?.cmd).toBe('answer k1 Build it here');
  });

  it('leads with the recommended option', () => {
    const [need] = buildNeeds([], [questionCard('k1', { opts: ['Hold', 'Build it here'], recommended: 1 })]);
    expect(need?.options[0]?.label).toBe('Build it here');
  });

  it('says in its evidence that the options were drafted rather than the agent’s own', () => {
    const [need] = buildNeeds([], [questionCard('k1')]);
    expect(need?.evidence.some((line) => line.includes('drafted'))).toBe(true);
  });

  it('skips a question carrying nothing to choose between', () => {
    expect(buildNeeds([], [questionCard('k1', { opts: [] })])).toEqual([]);
  });

  it('shows one entry when the same ask arrives as a card and as a lane question', () => {
    const lane = laneWithQuestion('lane-1', NOW - 60_000);
    const needs = buildNeeds([lane], [questionCard('k1')]);
    expect(needs).toHaveLength(1);
    expect(needs[0]?.askKey).toBe('k1');
  });

  it('ranks a real question ahead of a contentless confirm', () => {
    const needs = buildNeeds([], [confirmCard('dead', { ts: NOW - 900_000 }), questionCard('k1')]);
    expect(needs[0]?.kind).toBe('question');
  });
});
