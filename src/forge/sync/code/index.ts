/**
 * Re-exports the fetch/reconcile/sweep functions plus the deps shape and the real-deps
 * builder. `CodeSyncDeps` comes straight from `src/shared/sync-contract.ts` (stream A);
 * the type test at `tests/forge/sync/code/contract-shape.test.ts` proves it is used
 * verbatim, never a local re-declaration that could drift from it.
 */
export type { CodeSyncDeps } from '../../../shared/sync-contract.ts';

export { fetchRepos } from './fetch.ts';
export type { FetchReposResult } from './fetch.ts';
export { reconcilePrs } from './reconcile.ts';
export type { ReconcilePrsResult } from './reconcile.ts';
export { sweepWorktrees } from './worktrees.ts';
export type { SweepWorktreesResult, SweptWorktree } from './worktrees.ts';
export { buildCodeSyncDeps } from './real-deps.ts';
export type { BuildCodeSyncDepsOptions } from './real-deps.ts';
