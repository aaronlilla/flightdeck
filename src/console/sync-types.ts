/**
 * Copied verbatim from `2026-09-11-resync-contract.md` (stream A's
 * `src/shared/sync-contract.ts`, not yet merged). Import from here until that file
 * exists on this branch; swap the import to the shared file in the same commit that
 * rebases onto stream A. Types only -- no runtime.
 */
export type SyncScope = 'full' | 'queue' | 'sessions' | 'accounts' | 'machine' | 'inbox' | 'lanes';

export type SyncStageName =
  | 'stop-workers' | 'wipe-queue' | 'reset-watermarks'
  | 'fetch-repos' | 'reconcile-prs' | 'sweep-worktrees'
  | 'pull-jira' | 'watcher-on' | 'resume'
  // per-page scopes reuse names above where they apply, plus:
  | 'scan-sessions' | 'probe-accounts' | 'snapshot-machine' | 'refresh-inbox' | 'recheck-lanes';

export type SyncStageStatus = 'running' | 'ok' | 'failed' | 'skipped';

export interface SyncStage {
  name: SyncStageName;
  status: SyncStageStatus;
  startedAt: number;            // epoch ms
  endedAt?: number;
  counts: Record<string, number>; // e.g. { stopped: 2, wiped: 14, added: 5, reused: 3, planned: 2, removed: 4, kept: 9 }
  message?: string;             // one plain sentence; on failed, the error text, never a stack
}

export interface SyncRunRecord {
  scope: SyncScope;
  id: string;                   // uuid
  startedAt: number;
  endedAt?: number;
  stages: SyncStage[];          // in execution order; a stage not reached is absent, a stage skipped after a failure is present with status 'skipped'
  ok: boolean;                  // true only when every stage is 'ok'
}

export interface WatcherStatus {
  on: boolean;
  project: string | null;       // FORGE_BACKLOG_PROJECT or watcher.json's project
  pollSeconds: number;
  lastPollAt?: number;
  nextPollAt?: number;
  lastCount?: number;           // tickets observed on the last poll
  lastError?: string;           // last watcher.tick-error message, cleared on a good poll
}

export interface SyncStateResponse {
  runs: Record<SyncScope, SyncRunRecord | null>;
  watcher: WatcherStatus;
}
