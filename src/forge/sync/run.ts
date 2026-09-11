/**
 * R-68 item 4: the runner behind the resync board's one action. Generic over
 * `SyncScope` -- every stage is a plain injected function, and this file never imports
 * git, `gh`, or anything stream B/C/D own. A stage absent from `deps.stages` (the one
 * permitted placeholder, per the brief's guardrail, until streams B and C merge) is
 * `skipped` rather than `ok`, and a `skipped` stage never fails the run and never blocks
 * a later stage or `resume` -- only a thrown stage does that.
 */
import { randomUUID } from 'node:crypto';

import type {
  SyncRunRecord, SyncScope, SyncStage, SyncStageName, SyncStageStatus,
} from '../../shared/sync-contract.js';
import type { Journal } from '../journal.js';
import type { SyncStore } from './store.js';

export interface RunSyncContext {
  now: () => number;
}

export type SyncStageFn = (ctx: RunSyncContext) => Promise<{ counts: Record<string, number>; message?: string }>;

export interface RunSyncDeps {
  stages: Partial<Record<SyncStageName, SyncStageFn>>;
  journal: Journal;
  store: SyncStore;
  now?: () => number;
  id?: () => string;
}

/** `full`'s own nine stages, in the plan's order. Every other scope reuses the page-scope
 *  stage name the contract names for it -- a single-stage run, since a page sync has no
 *  multi-hop pipeline of its own. */
const STAGE_ORDER: Record<SyncScope, SyncStageName[]> = {
  full: [
    'stop-workers', 'wipe-queue', 'reset-watermarks',
    'fetch-repos', 'reconcile-prs', 'sweep-worktrees',
    'pull-jira', 'watcher-on', 'resume',
  ],
  queue: ['stop-workers', 'wipe-queue', 'reset-watermarks'],
  sessions: ['scan-sessions'],
  accounts: ['probe-accounts'],
  machine: ['snapshot-machine'],
  inbox: ['refresh-inbox'],
  lanes: ['recheck-lanes'],
};

export class SyncAlreadyRunningError extends Error {
  constructor(scope: SyncScope) {
    super(`sync ${scope} is already running`);
  }
}

function journalStage(journal: Journal, scope: SyncScope, id: string, stage: SyncStage): void {
  journal.append({
    event: 'sync.stage', actor: 'sync', scope, id, stage: stage.name, status: stage.status,
    counts: stage.counts, ...(stage.message ? { message: stage.message } : {}),
  } as never);
}

export interface SyncRunner {
  runSync(scope: SyncScope): Promise<SyncRunRecord>;
  isRunning(scope: SyncScope): boolean;
}

/**
 * One runner per `deps`, so the "already running" guard (order 4's falsifier 4: `resume`
 * must never run after a failure, checked by asserting it was never called) is scoped to
 * one server process, not shared global state that would make two independent specimens
 * in the same test file interfere with each other.
 */
export function createSyncRunner(deps: RunSyncDeps): SyncRunner {
  const running = new Set<SyncScope>();

  async function runSync(scope: SyncScope): Promise<SyncRunRecord> {
    if (running.has(scope)) throw new SyncAlreadyRunningError(scope);
    running.add(scope);

    // Everything after the guard above lives inside this try/finally -- a throw from
    // `deps.id()`, the initial `sync.started` journal append, or the first `store.save`
    // must still release `scope` from `running`, or one bad `deps.journal`/`deps.store`
    // call permanently wedges every future run of that scope for this process's life.
    try {
      const now = deps.now ?? Date.now;
      const id = deps.id ? deps.id() : randomUUID();
      const record: SyncRunRecord = { scope, id, startedAt: now(), stages: [], ok: false };
      deps.journal.append({ event: 'sync.started', actor: 'sync', scope, id } as never);
      deps.store.save(record);

      let failed = false;
      for (const name of STAGE_ORDER[scope]) {
        const startedAt = now();
        let status: SyncStageStatus;
        let counts: Record<string, number> = {};
        let message: string | undefined;

        if (failed) {
          status = 'skipped';
        } else {
          const fn = deps.stages[name];
          if (!fn) {
            status = 'skipped';
            message = 'not wired yet: stream B';
          } else {
            try {
              const result = await fn({ now });
              status = 'ok';
              counts = result.counts;
              message = result.message;
            } catch (error) {
              status = 'failed';
              message = error instanceof Error ? error.message : String(error);
              failed = true;
            }
          }
        }

        const stage: SyncStage = {
          name, status, startedAt, endedAt: now(), counts, ...(message ? { message } : {}),
        };
        record.stages.push(stage);
        journalStage(deps.journal, scope, id, stage);
        deps.store.save(record);
      }

      // A skipped stage (an absent one, or one downstream of a failure) never fails the
      // run on its own -- only a stage that actually threw does. This is what keeps the
      // one permitted stream-B/C placeholder from reading the whole run as broken.
      record.ok = record.stages.every((stage) => stage.status !== 'failed');
      record.endedAt = now();
      deps.journal.append({ event: 'sync.finished', actor: 'sync', scope, id, ok: record.ok } as never);
      deps.store.save(record);
      return record;
    } finally {
      running.delete(scope);
    }
  }

  return { runSync, isRunning: (scope) => running.has(scope) };
}
