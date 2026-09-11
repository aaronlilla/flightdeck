import { describe, expect, it } from 'vitest';

import type { ChainPacketState } from '../../../src/forge/chain.js';
import { computeBranchPr, computeQueuePr, computeRunPr, PR_CACHE_TTL_MS } from '../../../src/forge/console/pr.js';
import type { AttestationReaderFn, GhBranchLookupFn, GhDetailLookupFn } from '../../../src/forge/console/pr.js';

function chainWith(row: ChainPacketState): Map<string, ChainPacketState> {
  return new Map([[row.packetId, row]]);
}

describe('computeRunPr', () => {
  it('is null with no chain packet at all, and never calls gh', async () => {
    let called = false;
    const result = await computeRunPr('alpha', new Map(), {}, 1_000, async () => {
      called = true;
      return undefined;
    });
    expect(result.pr).toBeNull();
    expect(called).toBe(false);
  });

  it('looks up gh by the packet\'s branch and caches the answer', async () => {
    const chain = chainWith({
      packetId: 'p1', launched: { runKey: 'alpha' },
      provisioned: { worktreePath: 'w', branch: 'feature/ab-1' },
    });
    let calls = 0;
    const lookup = async (branch: string) => {
      calls += 1;
      expect(branch).toBe('feature/ab-1');
      return { number: 12, url: 'https://example/pull/12', isDraft: true, additions: 3, deletions: 1, changedFiles: 2 };
    };
    const first = await computeRunPr('alpha', chain, {}, 1_000, lookup);
    expect(first.pr).toEqual({ no: 12, url: 'https://example/pull/12', files: 2, add: 3, del: 1, draft: true });
    expect(calls).toBe(1);

    const second = await computeRunPr('alpha', chain, first.cache, 1_000 + 1, lookup);
    expect(second.pr).toEqual(first.pr);
    expect(calls).toBe(1);
  });

  it('re-checks gh once the cache entry is older than the TTL', async () => {
    const chain = chainWith({
      packetId: 'p1', launched: { runKey: 'alpha' },
      provisioned: { worktreePath: 'w', branch: 'feature/ab-1' },
    });
    let calls = 0;
    const lookup = async () => {
      calls += 1;
      return undefined;
    };
    const first = await computeRunPr('alpha', chain, {}, 0, lookup);
    await computeRunPr('alpha', chain, first.cache, PR_CACHE_TTL_MS + 1, lookup);
    expect(calls).toBe(2);
  });

  it('H1.3: fills checks/verdict/merged/title from a detail lookup and the attestation on disk', async () => {
    const chain = chainWith({
      packetId: 'p1', repo: 'o/n', launched: { runKey: 'alpha' },
      provisioned: { worktreePath: 'w', branch: 'feature/ab-1' },
    });
    const lookup = async () => ({
      number: 12, url: 'https://example/pull/12', isDraft: true, additions: 3, deletions: 1, changedFiles: 2,
    });
    const detailLookup: GhDetailLookupFn = async (repo, pr) => {
      expect(repo).toBe('o/n');
      expect(pr).toBe(12);
      return { headSha: 'sha1', isDraft: true, merged: false, title: 'add the merge chip', checks: 'success' };
    };
    const attestationReader: AttestationReaderFn = (repo, pr, head) => {
      expect(repo).toBe('o/n');
      expect(pr).toBe(12);
      expect(head).toBe('sha1');
      return { verdict: 'PASS WITH NOTES' };
    };
    const result = await computeRunPr('alpha', chain, {}, 1_000, lookup, detailLookup, attestationReader);
    expect(result.pr).toEqual({
      no: 12, url: 'https://example/pull/12', files: 2, add: 3, del: 1, draft: true,
      checks: 'success', merged: false, title: 'add the merge chip', verdict: 'PASS WITH NOTES', mergedAt: null,
    });
  });

  it('H1.3: leaves checks/verdict/merged/title unset with no detail lookup wired', async () => {
    const chain = chainWith({
      packetId: 'p1', repo: 'o/n', launched: { runKey: 'alpha' },
      provisioned: { worktreePath: 'w', branch: 'feature/ab-1' },
    });
    const lookup = async () => ({
      number: 12, url: 'https://example/pull/12', isDraft: true, additions: 3, deletions: 1, changedFiles: 2,
    });
    const result = await computeRunPr('alpha', chain, {}, 1_000, lookup);
    expect(result.pr).toEqual({ no: 12, url: 'https://example/pull/12', files: 2, add: 3, del: 1, draft: true });
  });
});

describe('computeQueuePr', () => {
  const basic = { no: 119, url: 'https://github.com/o/n/pull/119', files: 6, add: 360, del: 5, draft: true };

  it('item 7: reads checks/verdict/merged/title straight off repo+PR number, with no chain packet and no gh pr list', async () => {
    const detailLookup: GhDetailLookupFn = async (repo, pr) => {
      expect(repo).toBe('o/n');
      expect(pr).toBe(119);
      return { headSha: 'deadbeef', isDraft: true, merged: false, title: 'add the merge chip', checks: 'success' };
    };
    const attestationReader: AttestationReaderFn = (repo, pr, head) => {
      expect(repo).toBe('o/n');
      expect(pr).toBe(119);
      expect(head).toBe('deadbeef');
      return { verdict: 'PASS WITH NOTES' };
    };
    const result = await computeQueuePr('queue-BBZ-96', 'o/n', basic, {}, 1_000, detailLookup, attestationReader);
    expect(result.pr).toEqual({
      ...basic, checks: 'success', merged: false, title: 'add the merge chip', verdict: 'PASS WITH NOTES', mergedAt: null,
    });
    expect(result.cache['queue-BBZ-96']).toEqual({ pr: result.pr, at: 1_000, repo: 'o/n' });
  });

  it('item 7: leaves the basic PR fields alone when the detail lookup finds nothing', async () => {
    const detailLookup: GhDetailLookupFn = async () => undefined;
    const result = await computeQueuePr('queue-BBZ-96', 'o/n', basic, {}, 1_000, detailLookup);
    expect(result.pr).toEqual(basic);
  });

  // R-61 item 2: `gh`'s raw `closed` fact (state === 'CLOSED', no merge) rides along on
  // the same cached PR the merged flag already does, so `retireEligible` can tell a
  // closed-unmerged PR apart from one still genuinely open.
  it('R-61 item 2: carries the raw gh closed fact through to the cached PR', async () => {
    const detailLookup: GhDetailLookupFn = async () => (
      { headSha: 'deadbeef', isDraft: false, merged: false, title: 'abandoned work', checks: 'failure', closed: true }
    );
    const result = await computeQueuePr('queue-brief-x', 'o/n', basic, {}, 1_000, detailLookup);
    expect(result.pr.merged).toBe(false);
    expect(result.pr.closed).toBe(true);
  });

  it('R-61 item 1: writes the repo alongside the PR fact, for a lane with no queue item to read it from later', async () => {
    const detailLookup: GhDetailLookupFn = async () => (
      { headSha: 'deadbeef', isDraft: false, merged: true, title: 'shipped', checks: 'success', mergedAt: 2_000 }
    );
    const result = await computeQueuePr('queue-brief-y', 'aaronlilla/flightdeck', basic, {}, 1_000, detailLookup);
    expect(result.cache['queue-brief-y']).toMatchObject({ repo: 'aaronlilla/flightdeck' });
  });
});

describe('computeBranchPr', () => {
  it('item 11: finds a PR by branch with --state all, and caches it under the run', async () => {
    const branchLookup: GhBranchLookupFn = async (repo, branch) => {
      expect(repo).toBe('o/n');
      expect(branch).toBe('feature/s-b9d39bae548707e0');
      return {
        number: 39, url: 'https://github.com/o/n/pull/39', isDraft: true, mergedAt: null,
        title: 'dedupe warden.health on an open unregistered trip', headRefOid: 'f284c65',
      };
    };
    const result = await computeBranchPr('S-b9d39bae548707e0', 'o/n', 'feature/s-b9d39bae548707e0', {}, 1_000, branchLookup);
    expect(result.pr).toEqual({
      no: 39, url: 'https://github.com/o/n/pull/39', draft: true, merged: false,
      title: 'dedupe warden.health on an open unregistered trip', mergedAt: null,
    });
    expect(result.cache['S-b9d39bae548707e0']).toEqual({ pr: result.pr, at: 1_000, repo: 'o/n' });
  });

  it('item 11: finds an already-merged PR too, off mergedAt', async () => {
    const branchLookup: GhBranchLookupFn = async () => ({
      number: 40, url: 'u', isDraft: false, mergedAt: '2026-09-08T00:00:00Z', title: 't', headRefOid: 'abc',
    });
    const result = await computeBranchPr('alpha', 'o/n', 'feature/x', {}, 1_000, branchLookup);
    expect(result.pr?.merged).toBe(true);
  });

  it('item 11: caches a null when no PR is found by branch, and never re-looks-up inside the TTL', async () => {
    let calls = 0;
    const branchLookup: GhBranchLookupFn = async () => { calls += 1; return undefined; };
    const first = await computeBranchPr('alpha', 'o/n', 'feature/x', {}, 1_000, branchLookup);
    expect(first.pr).toBeNull();
    const second = await computeBranchPr('alpha', 'o/n', 'feature/x', first.cache, 1_000 + PR_CACHE_TTL_MS - 1, branchLookup);
    expect(second.pr).toBeNull();
    expect(calls).toBe(1);
  });

  it('item 11: never shells out -- the lookup is fully injected', async () => {
    let called = false;
    await computeBranchPr('alpha', 'o/n', 'feature/x', {}, 1_000, async () => { called = true; return undefined; });
    expect(called).toBe(true);
  });
});
