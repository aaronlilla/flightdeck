/**
 * Re-exports the fetch/reconcile/sweep functions plus the deps shape and the real-deps
 * builder. `CodeSyncDeps` is typed here verbatim against
 * `2026-09-11-resync-contract.md`'s `CodeSyncDeps` block until stream A merges
 * `src/shared/sync-contract.ts`; the type test at
 * `tests/forge/sync/code/contract-shape.test.ts` proves this file matches it once it
 * exists.
 */
export interface CodeSyncDeps {
  git(checkout: string, argv: string[]): Promise<string>;
  gh(argv: string[], cwd?: string): Promise<string>;
  repos: Array<{ repo: string; checkout: string; base: string }>;
  claimedPaths(): string[];
  worktreeStatus(path: string): { clean: boolean; pushed: boolean } | undefined;
  now(): number;
}

export { fetchRepos } from './fetch.ts';
export type { FetchReposResult } from './fetch.ts';
export { reconcilePrs } from './reconcile.ts';
export type { ReconcilePrsResult } from './reconcile.ts';
export { sweepWorktrees } from './worktrees.ts';
export type { SweepWorktreesResult, SweptWorktree } from './worktrees.ts';
export { buildCodeSyncDeps } from './real-deps.ts';
