/**
 * The re-sync program's shared contract (2026-09-11): one server action that wipes the
 * queue, re-syncs code and pages, pulls Jira, and starts the pipeline, plus the Jira
 * watcher's runtime on/off switch. Types only, no runtime, no imports from `src/forge`.
 *
 * Every stream in the re-sync program (`2026-09-11-resync-dispatch.md`) codes against
 * this file. It is Aaron's to change: a stream that needs a different shape records the
 * need in its own brief's Status section and stops that item rather than editing this
 * one unilaterally.
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

// Routes (all require X-Forge-Token except GET /state, unchanged):
//   GET  /sync                    -> SyncStateResponse
//   POST /sync/full  {confirm?}   -> 202 { started: true, id } | 409 { reason: 'running' } | the existing confirm-gate shape when unconfirmed
//   POST /sync/:scope             -> 202 { started: true, id } | 409 { reason: 'running' }   (scope in SyncScope minus 'full')
//   POST /watcher/on  {project?}  -> 200 WatcherStatus
//   POST /watcher/off             -> 200 WatcherStatus
//   GET  /state                   -> existing fields plus `watcher: WatcherStatus`
// Slice: 'sync' added to SliceName; published on every sync.stage / sync.finished journal row and on every watcher change.
// Journal rows (actor 'sync'): sync.started {scope,id}; sync.stage {scope,id,stage,status,counts,message?}; sync.finished {scope,id,ok};
//   sync.plan-reused {ticket,brief}; queue.wiped {count}; watcher.on {project}; watcher.off; accounts.probed {ok,failed}.

/**
 * Functions stream B exports (`src/forge/sync/code/index.ts`), called by the runner with
 * injected deps and never with real git or gh in a test.
 */
export interface CodeSyncDeps {
  git(checkout: string, argv: string[]): Promise<string>;     // resolves stdout, rejects on non-zero
  gh(argv: string[], cwd?: string): Promise<string>;           // same shape
  repos: Array<{ repo: string; checkout: string; base: string }>; // from FORGE_REPO_CHECKOUTS / FORGE_REPO_BASE via chain-env.ts
  claimedPaths(): string[];   // every `claims[].path` across the coordination registry's session files whose heartbeatAt is within 10 min
  worktreeStatus(path: string): Promise<{ clean: boolean; pushed: boolean } | undefined>; // sessions/cleanup.ts#worktreeStatusForAsync -- async so the ~90-worktree sweep never blocks the event loop
  now(): number;
}

export interface StageResult {
  counts: Record<string, number>;
  message?: string;
}

/**
 * Functions stream C exports (`src/forge/sync/pages/index.ts`), one per page scope, each
 * with every external effect injected.
 */
export type PageSyncStage<Deps> = (deps: Deps) => Promise<StageResult>;
