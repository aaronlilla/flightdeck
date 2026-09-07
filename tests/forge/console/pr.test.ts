import { describe, expect, it } from 'vitest';

import type { ChainPacketState } from '../../../src/forge/chain.js';
import { computeRunPr, PR_CACHE_TTL_MS } from '../../../src/forge/console/pr.js';
import type { AttestationReaderFn, GhDetailLookupFn } from '../../../src/forge/console/pr.js';

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
      checks: 'success', merged: false, title: 'add the merge chip', verdict: 'PASS WITH NOTES',
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
