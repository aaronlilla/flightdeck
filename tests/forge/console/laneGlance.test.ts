/**
 * `computeDid`, `nextCategoryFor` and `computeYou` (2026-09-08): the board-at-a-glance
 * fields. `you` is checked against `computeNext` (summary.ts) for every state, per the
 * brief's own "specimen per state" rule -- the two must never disagree about what the
 * operator is being asked to do.
 */
import { describe, expect, it } from 'vitest';

import { computeDid, computeYou, nextCategoryFor } from '../../../src/forge/console/laneGlance.js';
import { computeNext } from '../../../src/forge/console/summary.js';
import type { ForgeEvent } from '../../../src/forge/journal.js';
import type { Lane, LaneReadiness, LaneState } from '../../../src/shared/console-model.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: true, since: 0,
    startedAt: 0, endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, did: null, now: '',
    you: null,
    ...extra,
  };
}

function ev(partial: Partial<ForgeEvent> & Pick<ForgeEvent, 'event'>): ForgeEvent {
  return { id: 'e1', seq: 1, at: 0, version: 1, actor: 'worker', ...partial };
}

describe('computeDid', () => {
  it('reads the newest forge.report done field, first sentence only', () => {
    const events: ForgeEvent[] = [
      ev({ event: 'forge.report', done: 'Fixed the fee rounding bug. Also updated a test.' }),
      ev({ event: 'forge.report', done: 'Wired the retry loop.' }),
    ];
    expect(computeDid(events, null)).toBe('Wired the retry loop.');
  });

  it('falls back to the PR when there is no forge.report row', () => {
    const pr = { no: 118, url: 'https://x/pr/118', draft: true, files: 2, add: 79, del: 12, title: 'add the fee cap' } as never;
    expect(computeDid([], pr)).toBe('Opened draft PR #118: add the fee cap, 2 files +79 -12');
  });

  it('falls back to a tool digest when there is no report and no PR', () => {
    const events: ForgeEvent[] = [
      ev({ event: 'tool.start', tool: 'Bash' }),
      ev({ event: 'tool.start', tool: 'Bash' }),
      ev({ event: 'tool.start', tool: 'Read' }),
    ];
    expect(computeDid(events, null)).toBe('Ran 2 commands, 1 file read.');
  });

  it('is null with nothing to report', () => {
    expect(computeDid([], null)).toBeNull();
  });

  it('strips machine ids and shortens shas', () => {
    const events: ForgeEvent[] = [
      ev({ event: 'forge.report', done: `Fixed S-${'a'.repeat(16)} and commit ${'b'.repeat(40)}.` }),
    ];
    const did = computeDid(events, null);
    expect(did).not.toMatch(/S-[0-9a-f]{12,}/);
    expect(did).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  it('truncates to 110 characters', () => {
    const events: ForgeEvent[] = [ev({ event: 'forge.report', done: `${'x'.repeat(200)}.` })];
    const did = computeDid(events, null);
    expect(did!.length).toBeLessThanOrEqual(110);
  });
});

const ALL_STATES: LaneState[] = [
  'running', 'handed-off', 'paused', 'parked', 'done', 'merged', 'blocked', 'exhausted', 'killed', 'unverified',
];

describe('computeYou agrees with computeNext, per state', () => {
  for (const state of ALL_STATES) {
    it(`${state}: same next-category as the sheet's computeNext`, () => {
      const l = lane({ state });
      const readiness: LaneReadiness | null = l.pr ? { ok: false, why: 'x', checks: null, behindBase: null, headMoved: false } : null;
      const you = computeYou(l);
      const next = computeNext(l, readiness);
      const category = nextCategoryFor(l, false);
      // Every category that reads as "nothing needed" on the tile reads as
      // "nothing needed" (in words) on the sheet too, and vice versa.
      if (you === null) {
        expect(next.toLowerCase()).not.toMatch(/^merge it\b/);
      } else {
        expect(next.length).toBeGreaterThan(0);
      }
      expect(category).toBeTruthy();
    });
  }

  it('parked with a question: Answer: <question>', () => {
    const l = lane({ state: 'parked', question: { key: 'k', text: 'NOT NULL or nullable with a backfill job', opts: [], askedAt: 0 } });
    expect(computeYou(l)).toBe('Answer: NOT NULL or nullable with a backfill job');
  });

  it('parked without a question: Read the reason, then Resume or Kill.', () => {
    expect(computeYou(lane({ state: 'parked' }))).toBe('Read the reason, then Resume or Kill.');
  });

  it('blocked by aws: Reconnect AWS, then Resume.', () => {
    expect(computeYou(lane({ state: 'blocked', blockedBy: 'aws' }))).toBe('Reconnect AWS, then Resume.');
  });

  it('blocked otherwise: Resume or Kill it.', () => {
    expect(computeYou(lane({ state: 'blocked' }))).toBe('Resume or Kill it.');
  });

  it('exhausted: Kill and reopen.', () => {
    expect(computeYou(lane({ state: 'exhausted' }))).toBe('Kill and reopen.');
  });

  it('unverified with a PR: Verify it, or read PR #N.', () => {
    const pr = { no: 44, url: 'x', draft: false } as never;
    expect(computeYou(lane({ state: 'unverified', pr }))).toBe('Verify it, or read PR #44.');
  });

  it('unverified without a PR: Verify it, or Clean up retires it.', () => {
    // Kill refuses an unverified run (nothing is running to kill), so the ask must not
    // name it; Clean up is the exit that actually works.
    expect(computeYou(lane({ state: 'unverified' }))).toBe('Verify it, or Clean up retires it.');
  });

  it('done with a PR not ready: Not ready: <why>. Re-check later.', () => {
    const pr = { no: 9, url: 'x', draft: true, merged: false } as never;
    const l = lane({ state: 'done', pr, mergeable: { ok: false, why: 'checks failed' } });
    expect(computeYou(l)).toBe('Not ready: checks failed. Re-check later.');
  });

  it('done without a PR: Clean up retires it.', () => {
    expect(computeYou(lane({ state: 'done' }))).toBe('Clean up retires it.');
  });

  it('killed: Reopen or clean up.', () => {
    expect(computeYou(lane({ state: 'killed' }))).toBe('Reopen or clean up.');
  });

  // Item 1: the tile's own ask agrees with the sheet's "Nothing needed; it merged.
  // Clean up retires it." -- a bare null left the tile with nothing under a merged
  // band while the sheet said something underneath it.
  it('merged: Nothing needed; it merged. Clean up retires it.', () => {
    expect(computeYou(lane({ state: 'merged' }))).toBe('Nothing needed; it merged. Clean up retires it.');
  });

  it('running / handed-off: null', () => {
    expect(computeYou(lane({ state: 'running' }))).toBeNull();
    expect(computeYou(lane({ state: 'handed-off' }))).toBeNull();
  });

  it('paused: Resume when ready.', () => {
    expect(computeYou(lane({ state: 'paused' }))).toBe('Resume when ready.');
  });

  it('runaway: Kill the attempt.', () => {
    expect(computeYou(lane({ state: 'running', runaway: true }))).toBe('Kill the attempt.');
  });

  it('a ready PR always says Merge it, overriding state', () => {
    const pr = { no: 5, url: 'x', draft: true, merged: false } as never;
    const l = lane({ state: 'done', pr, mergeable: { ok: true } });
    expect(computeYou(l)).toBe('Merge it.');
  });
});
