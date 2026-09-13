import { describe, expect, it } from 'vitest';

import { noCiVerdict } from '../../../src/forge/intake/noCiGate.js';

/**
 * What the gate does when a repository runs no checks.
 *
 * Measured 2026-09-12: a ticket driven in through the console reached a draft pull
 * request in this console's own repository, whose workflows are disabled deliberately,
 * and parked on "checks never settled after 20 polls" -- a sentence about a wait that
 * never happened. Aaron's decision that day: run the repository's own verify on the head
 * and treat it as the check.
 *
 * The rules this holds to: never merge on a question that could not be asked, never
 * claim a timeout that did not happen, and change nothing at all for an environment that
 * wires none of this.
 */
const WHERE = { repo: 'aaronlilla/flightdeck', worktreePath: 'C:/dev/worktrees/x' };

describe('a gate on a repository with no checks', () => {
  it('waits, exactly as before, when nothing asked the question', async () => {
    expect(await noCiVerdict(WHERE, {})).toEqual({ kind: 'wait' });
  });

  it('waits when the repository does run checks', async () => {
    const verdict = await noCiVerdict(WHERE, { repoRunsChecks: async () => true });
    expect(verdict.kind).toBe('wait');
  });

  it('waits when the lookup itself failed, rather than reading that as "runs none"', async () => {
    const verdict = await noCiVerdict(WHERE, {
      repoRunsChecks: async () => { throw new Error('gh is not logged in'); },
    });
    expect(verdict.kind).toBe('wait');
  });

  it('passes the gate when the repository runs none and its own verify is green', async () => {
    const verdict = await noCiVerdict(WHERE, {
      repoRunsChecks: async () => false,
      runVerify: async () => ({ ok: true, output: 'all good' }),
    });
    expect(verdict.kind).toBe('passed');
    expect(verdict.kind === 'passed' && verdict.why).toMatch(/runs no checks; its own verify passed/);
  });

  it('fails the gate with what the verify said, not with a timeout', async () => {
    const verdict = await noCiVerdict(WHERE, {
      repoRunsChecks: async () => false,
      runVerify: async () => ({ ok: false, output: 'running tests\n\n  Tests  3 failed | 4068 passed\n' }),
    });
    expect(verdict.kind).toBe('failed');
    expect(verdict.kind === 'failed' && verdict.why).toMatch(/Tests {2}3 failed \| 4068 passed/);
  });

  it('says so plainly when there is no way to run the verify', async () => {
    const verdict = await noCiVerdict(WHERE, { repoRunsChecks: async () => false });
    expect(verdict.kind).toBe('cannot-check');
    expect(verdict.kind === 'cannot-check' && verdict.why)
      .toMatch(/runs no checks, and nothing here can run its own verify/);
  });

  it('says so when the item has no working tree to run it in', async () => {
    const verdict = await noCiVerdict({ ...WHERE, worktreePath: null }, {
      repoRunsChecks: async () => false,
      runVerify: async () => ({ ok: true, output: '' }),
    });
    expect(verdict.kind).toBe('cannot-check');
  });

  it('names the reason when the verify throws, rather than swallowing it', async () => {
    const verdict = await noCiVerdict(WHERE, {
      repoRunsChecks: async () => false,
      runVerify: async () => { throw new Error('npm is not on PATH'); },
    });
    expect(verdict.kind).toBe('cannot-check');
    expect(verdict.kind === 'cannot-check' && verdict.why).toMatch(/npm is not on PATH/);
  });

  it('waits when the item has no repository at all', async () => {
    const verdict = await noCiVerdict({ repo: null, worktreePath: null }, {
      repoRunsChecks: async () => false,
    });
    expect(verdict.kind).toBe('wait');
  });
});
