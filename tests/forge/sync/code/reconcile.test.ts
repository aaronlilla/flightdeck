import { describe, expect, it } from 'vitest';

import { reconcilePrs } from '../../../../src/forge/sync/code/reconcile.ts';
import type { CodeSyncDeps } from '../../../../src/forge/sync/code/index.ts';

interface GhCall { argv: string[]; cwd?: string }

interface RepoPr { repo: string; state: string; mergedAt: string | null; number: number; headRefName: string }

function buildDeps(byBranch: Map<string, RepoPr[]>, ghErrorBranches: Set<string>, onlyCheckout?: string) {
  const ghCalls: GhCall[] = [];
  const deps: CodeSyncDeps = {
    async git() {
      throw new Error('reconcilePrs must never call git');
    },
    async gh(argv, cwd) {
      ghCalls.push({ argv, cwd });
      const branchIdx = argv.indexOf('--head');
      const branch = branchIdx === -1 ? '' : (argv[branchIdx + 1] ?? '');
      if (ghErrorBranches.has(branch)) throw new Error(`gh: rate limited for ${branch}`);
      if (onlyCheckout && cwd !== onlyCheckout) return JSON.stringify([]);
      return JSON.stringify(byBranch.get(branch) ?? []);
    },
    repos: [
      { repo: 'aaronlilla/v2-React-Native', checkout: 'C:/dev/v2-React-Native', base: 'develop' },
      { repo: 'aaronlilla/BBManagementSystemV2', checkout: 'C:/dev/BBManagementSystemV2', base: 'develop' },
    ],
    claimedPaths: () => [],
    worktreeStatus: () => undefined,
    now: () => 0,
  };
  return { deps, ghCalls };
}

describe('reconcilePrs', () => {
  it('classifies merged, open, closed and no-PR keys', async () => {
    const byBranch = new Map<string, RepoPr[]>([
      ['feature/bbz-100', [{ repo: 'r', state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z', number: 10, headRefName: 'feature/bbz-100' }]],
      ['feature/bbz-101', [{ repo: 'r', state: 'OPEN', mergedAt: null, number: 11, headRefName: 'feature/bbz-101' }]],
      ['feature/bbz-102', [{ repo: 'r', state: 'CLOSED', mergedAt: null, number: 12, headRefName: 'feature/bbz-102' }]],
      ['feature/bbz-103', []],
    ]);
    const { deps } = buildDeps(byBranch, new Set());

    const result = await reconcilePrs(deps, ['bbz-100', 'bbz-101', 'bbz-102', 'bbz-103']);

    expect(result.shipped).toEqual([
      { key: 'bbz-100', repo: 'aaronlilla/v2-React-Native', pr: 10 },
      { key: 'bbz-100', repo: 'aaronlilla/BBManagementSystemV2', pr: 10 },
    ]);
    expect(result.open).toEqual([
      { key: 'bbz-101', repo: 'aaronlilla/v2-React-Native', pr: 11, branch: 'feature/bbz-101' },
      { key: 'bbz-101', repo: 'aaronlilla/BBManagementSystemV2', pr: 11, branch: 'feature/bbz-101' },
    ]);
    expect(result.none).toEqual(expect.arrayContaining(['bbz-102', 'bbz-102', 'bbz-103', 'bbz-103']));
    expect(result.none).toHaveLength(4);
  });

  it('checks both repos for one key and returns one entry per repo that has a PR', async () => {
    const byBranch = new Map<string, RepoPr[]>([
      ['feature/bbz-200', [{ repo: 'r', state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z', number: 20, headRefName: 'feature/bbz-200' }]],
    ]);
    const { deps, ghCalls } = buildDeps(byBranch, new Set(), 'C:/dev/v2-React-Native');

    const result = await reconcilePrs(deps, ['bbz-200']);

    expect(result.shipped).toHaveLength(1);
    expect(result.shipped[0]?.repo).toBe('aaronlilla/v2-React-Native');
    expect(result.none).toEqual(['bbz-200']); // the BBMS repo call returned no PR
    expect(ghCalls).toHaveLength(2);
  });

  it('accepts a hotfix- id through branchFor', async () => {
    const byBranch = new Map<string, RepoPr[]>([
      ['hotfix/urgent-fix', [{ repo: 'r', state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z', number: 30, headRefName: 'hotfix/urgent-fix' }]],
    ]);
    const { deps, ghCalls } = buildDeps(byBranch, new Set());

    const result = await reconcilePrs(deps, ['hotfix-urgent-fix']);

    expect(result.shipped.some((s) => s.key === 'hotfix-urgent-fix')).toBe(true);
    expect(ghCalls.every((c) => c.argv.includes('hotfix/urgent-fix'))).toBe(true);
  });

  it('picks the OPEN row over a stale merged/closed row when a reused branch name has both', async () => {
    const byBranch = new Map<string, RepoPr[]>([
      ['feature/bbz-400', [
        { repo: 'r', state: 'CLOSED', mergedAt: '2026-01-01T00:00:00Z', number: 50, headRefName: 'feature/bbz-400' },
        { repo: 'r', state: 'OPEN', mergedAt: null, number: 51, headRefName: 'feature/bbz-400' },
      ]],
    ]);
    const { deps } = buildDeps(byBranch, new Set());

    const result = await reconcilePrs(deps, ['bbz-400']);

    expect(result.open).toEqual([
      { key: 'bbz-400', repo: 'aaronlilla/v2-React-Native', pr: 51, branch: 'feature/bbz-400' },
      { key: 'bbz-400', repo: 'aaronlilla/BBManagementSystemV2', pr: 51, branch: 'feature/bbz-400' },
    ]);
    expect(result.shipped).toEqual([]);
  });

  it('reports a gh error for one key as none, logs a failed count, and never loses the others', async () => {
    const byBranch = new Map<string, RepoPr[]>([
      ['feature/bbz-300', [{ repo: 'r', state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z', number: 40, headRefName: 'feature/bbz-300' }]],
    ]);
    const ghErrorBranches = new Set(['feature/bbz-301']);
    const { deps } = buildDeps(byBranch, ghErrorBranches);
    const errorSpy: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => { errorSpy.push(String(msg)); };

    let result;
    try {
      result = await reconcilePrs(deps, ['bbz-300', 'bbz-301']);
    } finally {
      console.error = originalError;
    }

    expect(result.shipped.some((s) => s.key === 'bbz-300')).toBe(true);
    expect(result.none.filter((k) => k === 'bbz-301')).toHaveLength(2); // both repos errored -> both counted as none
    expect(errorSpy.some((m) => /failed=2/.test(m))).toBe(true);
  });
});
