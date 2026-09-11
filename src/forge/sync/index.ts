/**
 * R-68/R-73: the production wiring for the `full` sync and the five per-page scopes.
 * `fetch-repos`, `reconcile-prs` and `sweep-worktrees` bind stream B's real functions
 * (`./code/index.js`) through `buildCodeSyncDeps`; the five page scopes bind stream C's
 * real functions (`./pages/index.js`) through `buildPageDeps`. `reconcile-prs` checks
 * the ticket keys the queue held right before `wipe-queue` cleared it, and its `shipped`
 * result feeds `pull-jira`'s `shippedKeys` so a ticket already merged is never re-queued
 * -- both threaded through closured state in the order `run.ts`'s `full` scope actually
 * runs them (`wipe-queue` before `reconcile-prs` before `pull-jira`).
 */
import { join } from 'node:path';

import { forgeHome, intakeBriefsDir, journalPath, killSwitchPath, lanesDir, registryDir } from '../paths.js';
import type { QueueStore } from '../intake/queueStore.js';
import { resetWatermarks } from '../intake/watermarkStore.js';
import { jiraConfigFromEnv } from '../queue-wire.js';
import { watcherFeed } from '../intake/watcherWire.js';
import { writeQueuePaused } from '../console/queue-pause.js';
import { Journal } from '../journal.js';
import { Registry } from '../registry.js';
import { clearKillSwitch, Fleet, Lanes } from '../supervisor.js';
import { pullJira } from './jira-pull.js';
import { buildCodeSyncDeps, fetchRepos, reconcilePrs, sweepWorktrees, type BuildCodeSyncDepsOptions } from './code/index.js';
import { buildPageDeps, type PageDepsInput } from './pages/index.js';
import type { SyncStageFn } from './run.js';
import type { SyncStageName } from '../../shared/sync-contract.js';
import { writeWatcherState, type JiraWatcher } from './watcher-state.js';

export interface ProductionSyncDeps {
  queueStore: QueueStore;
  watcher: JiraWatcher;
  journal: Journal;
  /** Page-sync's own two collaborators (`sync/pages/index.ts#PageDepsInput`). Optional
   *  so an existing caller with no lanes/registry concept (e.g. `index.test.ts`'s
   *  `watcher-on` specimen) keeps compiling against a harmless default. */
  registry?: PageDepsInput['registry'];
  consoleReads?: PageDepsInput['consoleReads'];
  /** Code-sync's real-deps overrides, for a test only -- production always omits both
   *  and gets `buildCodeSyncDeps`'s real git/gh/session-claim reads. */
  env?: NodeJS.ProcessEnv;
  execRun?: BuildCodeSyncDepsOptions['execRun'];
  sessionsDir?: string;
}

export interface ProductionSyncStages {
  stages: Partial<Record<SyncStageName, SyncStageFn>>;
  /** Undoes what `stop-workers` engaged when a later stage throws: the fleet-wide kill
   *  switch. The queue stays paused and the watcher stays off (nothing was synced), so
   *  a failed run leaves the fleet quiet, never dead. Live escape 2026-09-11 12:12. */
  onFailure: () => Promise<void>;
}

export function buildProductionSyncStages(deps: ProductionSyncDeps): ProductionSyncStages {
  const codeSyncDeps = buildCodeSyncDeps(deps.env ?? process.env, {
    execRun: deps.execRun, sessionsDir: deps.sessionsDir,
  });
  const pageDeps = buildPageDeps({
    registry: deps.registry ?? { all: () => [] },
    consoleReads: deps.consoleReads ?? { lanesResponse: () => ({ lanes: [] }), runRecheckResponse: async () => undefined },
  });

  let queueTicketsAtWipe: string[] = [];
  let shippedKeysFromReconcile: string[] = [];

  const stages: Partial<Record<SyncStageName, SyncStageFn>> = {
    'stop-workers': async () => {
      const fleet = new Fleet(new Lanes(lanesDir()), new Registry(registryDir()), journalPath(), killSwitchPath());
      const result = await fleet.stopAll('sync full: stopping running workers');
      return { counts: { stopped: result.stopped.length, stale: result.stale.length } };
    },

    'wipe-queue': async () => {
      queueTicketsAtWipe = Array.from(new Set(
        deps.queueStore.all().map((item) => item.ticket).filter((ticket): ticket is string => Boolean(ticket)),
      ));
      const count = deps.queueStore.wipe(deps.journal);
      return { counts: { wiped: count } };
    },

    'reset-watermarks': async () => {
      const deleted = resetWatermarks(join(forgeHome(), 'intake'));
      return { counts: { reset: deleted.length } };
    },

    'fetch-repos': async () => {
      const result = await fetchRepos(codeSyncDeps);
      return {
        counts: { fetched: result.fetched.length, failed: result.failed.length },
        ...(result.failed.length ? { message: result.failed.map((f) => `${f.repo}: ${f.message}`).join('; ') } : {}),
      };
    },

    'reconcile-prs': async () => {
      const result = await reconcilePrs(codeSyncDeps, queueTicketsAtWipe);
      // A key can land in both `shipped` and `open` -- one repo's half merged, another
      // repo's half still open (reconcile.ts's own doc comment names this case). Only a
      // key with NO open half is safe to treat as shipped for `pull-jira`'s skip list;
      // otherwise the still-open half would silently fall out of the queue for good.
      const openKeys = new Set(result.open.map((row) => row.key));
      shippedKeysFromReconcile = [...new Set(
        result.shipped.map((row) => row.key).filter((key) => !openKeys.has(key)),
      )];
      return { counts: { shipped: result.shipped.length, open: result.open.length, none: result.none.length } };
    },

    'sweep-worktrees': async () => {
      const result = await sweepWorktrees(codeSyncDeps);
      return { counts: { removed: result.removed.length, kept: result.kept.length } };
    },

    'pull-jira': async () => {
      const config = jiraConfigFromEnv();
      if (!config) {
        return { counts: {} as Record<string, number>, message: 'jira not configured: missing FORGE_JIRA_SITE, FORGE_JIRA_EMAIL, FORGE_JIRA_TOKEN' };
      }
      const project = deps.watcher.status().project ?? process.env['FORGE_BACKLOG_PROJECT'] ?? null;
      if (!project) return { counts: {} as Record<string, number>, message: 'no FORGE_BACKLOG_PROJECT configured' };
      const feed = watcherFeed(project, config, []);
      const result = await pullJira({
        feed, store: deps.queueStore, briefsDir: intakeBriefsDir(), shippedKeys: shippedKeysFromReconcile, journal: deps.journal,
      });
      return {
        counts: {
          added: result.added.length, reused: result.reused.length,
          planned: result.planned.length, skipped: result.skipped.length,
        },
      };
    },

    'watcher-on': async () => {
      const project = deps.watcher.status().project ?? process.env['FORGE_BACKLOG_PROJECT'] ?? null;
      if (!project) return { counts: {}, message: 'no project configured for the watcher' };
      await deps.watcher.start(project);
      // /code-review medium finding: without this, a full sync's own watcher-on stage
      // started the engine in memory but never wrote watcher.json, so the two ways of
      // turning the watcher on (this stage and POST /watcher/on) left different
      // persisted state -- a restart right after a full sync would not bring it back.
      writeWatcherState({ on: true, project });
      return { counts: {} };
    },

    resume: async () => {
      clearKillSwitch(killSwitchPath());
      writeQueuePaused(false);
      return { counts: {} };
    },

    'scan-sessions': async () => pageDeps.sessions(),
    'probe-accounts': async () => pageDeps.accounts(),
    'snapshot-machine': async () => pageDeps.machine(),
    'refresh-inbox': async () => pageDeps.inbox(),
    'recheck-lanes': async () => pageDeps.lanes(),
  };

  // No pre-confirm worktree count: computing one runs a full dry-run sweep, and
  // `operator-experience.md` §10 forbids a route blocking on a process sweep (this
  // confirm dialog blocking on it is the specimen that rule was written against). The
  // real removed count shows live on the `sweep-worktrees` stage as it runs, which
  // happens only after the operator confirms -- nothing is removed before then.
  return {
    stages,
    onFailure: async () => { clearKillSwitch(killSwitchPath()); },
  };
}
