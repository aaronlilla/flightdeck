import { describe, expect, it } from 'vitest';

import { sweepWorktrees } from '../../../../src/forge/sync/code/worktrees.ts';
import type { CodeSyncDeps } from '../../../../src/forge/sync/code/index.ts';

interface GitCall { checkout: string; argv: string[] }
interface GhCall { argv: string[]; cwd?: string }

function porcelain(entries: Array<{ path: string; branch: string | null }>): string {
  return entries
    .map((e) => {
      const branchLine = e.branch === null ? 'detached' : `branch refs/heads/${e.branch}`;
      return `worktree ${e.path}\nHEAD deadbeef\n${branchLine}`;
    })
    .join('\n\n');
}

interface Row {
  reason: string;
  path: string;
  branch: string;
  status: { clean: boolean; pushed: boolean } | undefined;
  claimed: boolean;
  claimedAfterSnapshot?: boolean;
  pr: { number: number; state: string; mergedAt: string | null } | null;
  ghError?: boolean;
  expectRemoved: boolean;
}

const MAIN_PATH = 'D:/work/flightdeck';
const CHECKOUT = MAIN_PATH;
const REPO = 'aaronlilla/flightdeck';

function buildRows(): Row[] {
  return [
    { reason: 'dirty', path: 'D:/work/worktrees/flightdeck--dirty', branch: 'feature/dirty',
      status: { clean: false, pushed: true }, claimed: false,
      pr: { number: 1, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z' }, expectRemoved: false },
    { reason: 'unpushed', path: 'D:/work/worktrees/flightdeck--unpushed', branch: 'feature/unpushed',
      status: { clean: true, pushed: false }, claimed: false,
      pr: { number: 2, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z' }, expectRemoved: false },
    { reason: 'claimed', path: 'D:/work/worktrees/flightdeck--claimed', branch: 'feature/claimed',
      status: { clean: true, pushed: true }, claimed: true,
      pr: { number: 3, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z' }, expectRemoved: false },
    { reason: 'claimed-after-snapshot', path: 'D:/work/worktrees/flightdeck--late-claim', branch: 'feature/late-claim',
      status: { clean: true, pushed: true }, claimed: false, claimedAfterSnapshot: true,
      pr: { number: 4, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z' }, expectRemoved: false },
    { reason: 'pr-open', path: 'D:/work/worktrees/flightdeck--open', branch: 'feature/open',
      status: { clean: true, pushed: true }, claimed: false,
      pr: { number: 5, state: 'OPEN', mergedAt: null }, expectRemoved: false },
    { reason: 'no-pr', path: 'D:/work/worktrees/flightdeck--nopr', branch: 'feature/nopr',
      status: { clean: true, pushed: true }, claimed: false, pr: null, expectRemoved: false },
    { reason: 'gh-error', path: 'D:/work/worktrees/flightdeck--gherr', branch: 'feature/gherr',
      status: { clean: true, pushed: true }, claimed: false, pr: null, ghError: true, expectRemoved: false },
    { reason: 'merged-clean', path: 'D:/work/worktrees/flightdeck--merged', branch: 'feature/merged',
      status: { clean: true, pushed: true }, claimed: false,
      pr: { number: 6, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z' }, expectRemoved: true },
    { reason: 'closed-clean', path: 'D:/work/worktrees/flightdeck--closed', branch: 'feature/closed',
      status: { clean: true, pushed: true }, claimed: false,
      pr: { number: 7, state: 'CLOSED', mergedAt: null }, expectRemoved: true },
  ];
}

function buildDeps(rows: Row[], opts?: { dryRun?: boolean }) {
  const gitCalls: GitCall[] = [];
  const ghCalls: GhCall[] = [];
  const rowByPath = new Map(rows.map((r) => [r.path, r]));
  let snapshotTaken = false;

  const deps: CodeSyncDeps = {
    async git(checkout, argv) {
      gitCalls.push({ checkout, argv });
      if (argv[0] === 'worktree' && argv[1] === 'list') {
        return porcelain([{ path: MAIN_PATH, branch: 'main' }, ...rows.map((r) => ({ path: r.path, branch: r.branch }))]);
      }
      if (argv[0] === 'worktree' && argv[1] === 'remove') {
        if (argv.includes('--force')) throw new Error('unexpected --force');
        const path = argv[2] ?? '';
        const row = rowByPath.get(path);
        if (!row || !row.expectRemoved) throw new Error(`unexpected worktree remove for ${path}`);
        return '';
      }
      if (argv[0] === 'branch' && argv[1] === '-D') {
        const branch = argv[2] ?? '';
        const row = rows.find((r) => r.branch === branch);
        if (!row || !row.expectRemoved) throw new Error(`unexpected branch -D for ${branch}`);
        return '';
      }
      throw new Error(`unexpected git argv: ${argv.join(' ')}`);
    },
    async gh(argv) {
      ghCalls.push({ argv });
      const branchIdx = argv.indexOf('--head');
      const branch = branchIdx === -1 ? undefined : argv[branchIdx + 1];
      const row = rows.find((r) => r.branch === branch);
      if (!row) throw new Error(`unexpected gh call for branch ${branch}`);
      if (row.ghError) throw new Error('gh: rate limited');
      return JSON.stringify(row.pr ? [row.pr] : []);
    },
    repos: [{ repo: REPO, checkout: CHECKOUT, base: 'main' }],
    claimedPaths() {
      if (!snapshotTaken) {
        snapshotTaken = true;
        return rows.filter((r) => r.claimed).map((r) => r.path);
      }
      return rows.filter((r) => r.claimed || r.claimedAfterSnapshot).map((r) => r.path);
    },
    async worktreeStatus(path) {
      return rowByPath.get(path)?.status;
    },
    now: () => 0,
  };

  return { deps, gitCalls, ghCalls };
}

describe('sweepWorktrees', () => {
  it('decides one row per reason and removes only merged-clean and closed-clean', async () => {
    const rows = buildRows();
    const { deps, gitCalls } = buildDeps(rows);

    const result = await sweepWorktrees(deps);

    for (const row of rows) {
      if (row.expectRemoved) {
        const removed = result.removed.find((r) => r.path === row.path);
        expect(removed, `expected ${row.path} to be removed`).toBeDefined();
        expect(removed?.reason).toBe(row.reason);
      } else {
        const kept = result.kept.find((r) => r.path === row.path);
        expect(kept, `expected ${row.path} to be kept`).toBeDefined();
        expect(kept?.reason).toBe(row.reason);
      }
    }

    const removeCalls = gitCalls.filter((c) => c.argv[0] === 'worktree' && c.argv[1] === 'remove');
    const branchDCalls = gitCalls.filter((c) => c.argv[0] === 'branch' && c.argv[1] === '-D');
    expect(removeCalls).toHaveLength(2);
    expect(branchDCalls).toHaveLength(2);
    for (const call of removeCalls) expect(call.argv).not.toContain('--force');
  });

  it('never touches the main checkout entry from the porcelain list', async () => {
    const rows = buildRows();
    const { deps, gitCalls } = buildDeps(rows);
    await sweepWorktrees(deps);
    const removeCalls = gitCalls.filter((c) => c.argv[0] === 'worktree' && c.argv[1] === 'remove');
    expect(removeCalls.some((c) => c.argv[2] === MAIN_PATH)).toBe(false);
  });

  it('dryRun returns the same decisions with zero worktree remove calls', async () => {
    const rows = buildRows();
    const { deps, gitCalls } = buildDeps(rows, { dryRun: true });
    const result = await sweepWorktrees(deps, { dryRun: true });

    for (const row of rows) {
      if (row.expectRemoved) {
        expect(result.removed.find((r) => r.path === row.path)?.reason).toBe(row.reason);
      } else {
        expect(result.kept.find((r) => r.path === row.path)?.reason).toBe(row.reason);
      }
    }

    const removeCalls = gitCalls.filter((c) => c.argv[0] === 'worktree' && c.argv[1] === 'remove');
    const branchDCalls = gitCalls.filter((c) => c.argv[0] === 'branch' && c.argv[1] === '-D');
    expect(removeCalls).toHaveLength(0);
    expect(branchDCalls).toHaveLength(0);
  });

  it("the fake git rejects a worktree remove the decision table never authorized", async () => {
    const rows = buildRows();
    const { deps } = buildDeps(rows);
    const dirty = rows.find((r) => r.reason === 'dirty')!;
    await expect(deps.git(CHECKOUT, ['worktree', 'remove', dirty.path])).rejects.toThrow();
    await expect(deps.git(CHECKOUT, ['worktree', 'remove', dirty.path, '--force'])).rejects.toThrow('--force');
  });

  it('a worktreeStatus throw for one worktree keeps that worktree and never aborts the whole sweep', async () => {
    const rows = buildRows();
    const badPath = rows.find((r) => r.reason === 'merged-clean')!.path;
    const { deps } = buildDeps(rows);
    const realStatus = deps.worktreeStatus;
    deps.worktreeStatus = (path: string) => {
      if (path === badPath) throw new Error('ENOENT: worktree gone from disk');
      return realStatus(path);
    };

    const result = await sweepWorktrees(deps);

    const bad = result.kept.find((r) => r.path === badPath);
    expect(bad, 'the throwing worktree should be kept, not crash the sweep').toBeDefined();
    expect(bad?.reason).toBe('status-error');
    // every other row still got decided
    const closed = rows.find((r) => r.reason === 'closed-clean')!;
    expect(result.removed.some((r) => r.path === closed.path)).toBe(true);
  });

  it('a git worktree remove failure keeps that worktree as remove-error and never aborts the whole sweep', async () => {
    const rows = buildRows();
    const badPath = rows.find((r) => r.reason === 'merged-clean')!.path;
    const { deps } = buildDeps(rows);
    const realGit = deps.git;
    deps.git = async (checkout: string, argv: string[]) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove' && argv[2] === badPath) {
        throw new Error(`git worktree failed: error: failed to delete '${badPath}': Permission denied`);
      }
      return realGit(checkout, argv);
    };

    const result = await sweepWorktrees(deps);

    const bad = result.kept.find((r) => r.path === badPath);
    expect(bad, 'the unremovable worktree should be kept, not crash the sweep').toBeDefined();
    expect(bad?.reason).toBe('remove-error');
    expect(result.removed.some((r) => r.path === badPath)).toBe(false);
    // the row after it still got removed
    const closed = rows.find((r) => r.reason === 'closed-clean')!;
    expect(result.removed.some((r) => r.path === closed.path)).toBe(true);
  });

  it('picks the OPEN row over a stale merged/closed row when a reused branch name has both', async () => {
    const rows = buildRows();
    const { deps } = buildDeps(rows);
    const realGh = deps.gh;
    const target = rows.find((r) => r.reason === 'no-pr')!;
    deps.gh = async (argv: string[], cwd?: string) => {
      const branchIdx = argv.indexOf('--head');
      const branch = branchIdx === -1 ? undefined : argv[branchIdx + 1];
      if (branch === target.branch) {
        return JSON.stringify([
          { number: 99, state: 'CLOSED', mergedAt: '2026-01-01T00:00:00Z' },
          { number: 100, state: 'OPEN', mergedAt: null },
        ]);
      }
      return realGh(argv, cwd);
    };

    const result = await sweepWorktrees(deps);

    expect(result.kept.find((r) => r.path === target.path)?.reason).toBe('pr-open');
    expect(result.removed.some((r) => r.path === target.path)).toBe(false);
  });

  it('normalizes claimed-path comparison across backslashes, trailing slash and case', async () => {
    const rows = buildRows();
    const target = rows.find((r) => r.reason === 'merged-clean')!;
    const { deps } = buildDeps(rows);
    const realClaimedPaths = deps.claimedPaths;
    deps.claimedPaths = () => [...realClaimedPaths(), target.path.toUpperCase().replace(/\//g, '\\') + '\\'];

    const result = await sweepWorktrees(deps);

    expect(result.kept.find((r) => r.path === target.path)?.reason).toBe('claimed');
    expect(result.removed.some((r) => r.path === target.path)).toBe(false);
  });

  it('labels a genuinely detached-HEAD worktree distinctly from the main checkout', async () => {
    const rows = buildRows();
    const { deps, gitCalls } = buildDeps(rows);
    const realGit = deps.git;
    deps.git = async (checkout: string, argv: string[]) => {
      if (argv[0] === 'worktree' && argv[1] === 'list') {
        const base = await realGit(checkout, argv);
        return `${base}\n\nworktree D:/work/worktrees/flightdeck--detached\nHEAD deadbeef\ndetached`;
      }
      return realGit(checkout, argv);
    };

    const result = await sweepWorktrees(deps);

    const detached = result.kept.find((r) => r.path === 'D:/work/worktrees/flightdeck--detached');
    expect(detached, 'expected a kept row for the detached worktree').toBeDefined();
    expect(detached?.reason).toBe('detached');
    void gitCalls;
  });
});
