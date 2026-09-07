/**
 * I16: the post-push drift check must give GitHub's asynchronous mergeable computation
 * a chance to finish before raising a blocker over a branch that is only seconds old.
 */
import { describe, expect, it } from 'vitest';

import type { DriftClock, Mergeable } from '../../src/forge/drift.js';
import {
  classifyDrift, classifyUnknown, driftBlocker, readMergeableDetailed, resolveMergeable,
} from '../../src/forge/drift.js';

/** Advances its own virtual clock on `sleep` rather than waiting for real -- the
 *  falsifier this closes is a specimen that sleeps for real. */
function fakeClock(): DriftClock {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
}

describe('I16: resolveMergeable retries an UNKNOWN read before giving up', () => {
  it('unknown twice then mergeable raises nothing', async () => {
    const reads: Mergeable[] = ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'];
    let calls = 0;
    const state = await resolveMergeable(async () => reads[calls++]!, fakeClock());
    expect(calls).toBe(3);
    expect(state).toBe('MERGEABLE');
    expect(driftBlocker('r1', state)).toBeUndefined();
  });

  it('unknown for the whole window raises once, after retrying on the 10s cadence', async () => {
    let calls = 0;
    const clock = fakeClock();
    const state = await resolveMergeable(async () => { calls++; return 'UNKNOWN'; }, clock);
    // 90s window / 10s interval: an initial read plus nine retries.
    expect(calls).toBe(10);
    expect(state).toBe('UNKNOWN');
    const blocker = driftBlocker('r1', state);
    expect(blocker?.question).toMatch(/could not be read, and unknown is not passing/);
  });

  it('a confirmed conflict raises at once, with no retry', async () => {
    let calls = 0;
    const state = await resolveMergeable(async () => { calls++; return 'CONFLICTING'; }, fakeClock());
    expect(calls).toBe(1);
    expect(state).toBe('CONFLICTING');
    expect(driftBlocker('r1', state)?.question).toMatch(/conflicts/);
  });
});

describe('B.5: gh UNKNOWN classification', () => {
  it('classifies an auth failure', () => {
    expect(classifyUnknown('gh: not logged into any GitHub hosts. Run gh auth login')).toBe('auth');
    expect(classifyUnknown('HTTP 401: Bad credentials')).toBe('auth');
  });

  it('classifies a rate limit', () => {
    expect(classifyUnknown('HTTP 403: API rate limit exceeded for user')).toBe('rate-limit');
  });

  it('classifies plain unreadable output as other', () => {
    expect(classifyUnknown('not json at all')).toBe('other');
    expect(classifyUnknown('')).toBe('other');
  });

  it('readMergeableDetailed only carries a reason when there is one to classify', () => {
    expect(readMergeableDetailed('{"mergeable":"MERGEABLE"}')).toEqual({ state: 'MERGEABLE' });
    expect(readMergeableDetailed('gh auth login required')).toEqual({ state: 'UNKNOWN', reason: 'auth' });
    expect(readMergeableDetailed('garbage')).toEqual({ state: 'UNKNOWN' });
  });

  it('classifyDrift: MERGEABLE clears', () => {
    expect(classifyDrift('r1', '{"mergeable":"MERGEABLE"}')).toEqual({ kind: 'clear' });
  });

  it('classifyDrift: an auth or rate-limit UNKNOWN is a credential lapse, never a blocker', () => {
    expect(classifyDrift('r1', 'gh auth login required')).toEqual({ kind: 'credential-lapse', account: 'gh' });
    expect(classifyDrift('r1', 'API rate limit exceeded', 'the base branch', 'gh-bot'))
      .toEqual({ kind: 'credential-lapse', account: 'gh-bot' });
  });

  it('classifyDrift: CONFLICTING and a plain unreadable UNKNOWN both stay a blocker', () => {
    expect(classifyDrift('r1', '{"mergeable":"CONFLICTING"}').kind).toBe('blocker');
    expect(classifyDrift('r1', 'garbage').kind).toBe('blocker');
  });
});
