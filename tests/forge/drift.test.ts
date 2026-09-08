/**
 * I16: the post-push drift check must give GitHub's asynchronous mergeable computation
 * a chance to finish before raising a blocker over a branch that is only seconds old.
 */
import { describe, expect, it } from 'vitest';

import type { DriftClock, Mergeable } from '../../src/forge/drift.js';
import {
  classifyDrift, classifyDriftRead, classifyUnknown, driftBlocker, readMergeableDetailed,
  resolveMergeable, resolveMergeableRead,
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
    // `reason` is asserted by presence rather than by an exhaustive object match: the
    // read also carries `output` (and `base`, when the call reported one) for the caller
    // that has to quote the failure, and this test is about the reason alone.
    expect(readMergeableDetailed('{"mergeable":"MERGEABLE"}')).toMatchObject({ state: 'MERGEABLE' });
    expect(readMergeableDetailed('{"mergeable":"MERGEABLE"}').reason).toBeUndefined();
    expect(readMergeableDetailed('gh auth login required')).toMatchObject({ state: 'UNKNOWN', reason: 'auth' });
    expect(readMergeableDetailed('garbage')).toMatchObject({ state: 'UNKNOWN' });
    expect(readMergeableDetailed('garbage').reason).toBeUndefined();
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

describe('W1: the reason survives the read and the retry window', () => {
  const AUTH_SPECIMEN = 'gh: To get started with GitHub CLI, please run:  gh auth login\n'
    + 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API '
    + 'authentication token.\nnot logged into any GitHub hosts';
  const RATE_LIMIT_SPECIMEN = 'gh: API rate limit exceeded for user ID 1234567. '
    + 'If you reach out to GitHub Support for help, please include the request ID.';

  it('readMergeableDetailed carries the raw output back, so a caller can classify and quote it', () => {
    const read = readMergeableDetailed(AUTH_SPECIMEN);
    expect(read.state).toBe('UNKNOWN');
    expect(read.reason).toBe('auth');
    expect(read.output).toBe(AUTH_SPECIMEN);
  });

  it('readMergeableDetailed reads baseRefName off the same gh call', () => {
    const read = readMergeableDetailed(JSON.stringify({ mergeable: 'CONFLICTING', baseRefName: 'develop' }));
    expect(read.state).toBe('CONFLICTING');
    expect(read.base).toBe('develop');
  });

  it('classifyDriftRead names the base the read itself reported', () => {
    const read = readMergeableDetailed(JSON.stringify({ mergeable: 'CONFLICTING', baseRefName: 'develop' }));
    const outcome = classifyDriftRead('r1', read);
    expect(outcome.kind).toBe('blocker');
    if (outcome.kind !== 'blocker') throw new Error('expected a blocker');
    expect(outcome.ask.question).toContain('develop');
    expect(outcome.ask.question).not.toContain('the base branch');
  });

  it('classifyDriftRead routes an auth read and a rate-limit read to a credential lapse', () => {
    for (const specimen of [AUTH_SPECIMEN, RATE_LIMIT_SPECIMEN]) {
      const outcome = classifyDriftRead('r1', readMergeableDetailed(specimen), 'github');
      expect(outcome).toEqual({ kind: 'credential-lapse', account: 'github' });
    }
  });

  it('resolveMergeableRead stops retrying the moment the read explains itself', async () => {
    let calls = 0;
    const read = await resolveMergeableRead(async () => {
      calls++;
      return readMergeableDetailed(AUTH_SPECIMEN);
    }, fakeClock());
    expect(calls).toBe(1);
    expect(read.reason).toBe('auth');
  });

  it('resolveMergeableRead still retries a plain still-computing UNKNOWN across the window', async () => {
    let calls = 0;
    const read = await resolveMergeableRead(async () => {
      calls++;
      return readMergeableDetailed('');
    }, fakeClock());
    expect(calls).toBe(10);
    expect(read.state).toBe('UNKNOWN');
    expect(read.reason).toBeUndefined();
  });
});
