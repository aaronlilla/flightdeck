/**
 * R-68: the production wiring for the `full` sync. Six of the nine stages are stream A's
 * own and real here; `fetch-repos`, `reconcile-prs` and `sweep-worktrees` (stream B) are
 * deliberately left out of the returned map -- `run.ts`'s own absent-stage handling marks
 * each `skipped` with `not wired yet: stream B`, never `ok`, which is the one permitted
 * placeholder this brief allows. `pull-jira`'s `shippedKeys` degrades to `[]` until
 * `reconcile-prs` exists to report one, which only means nothing is excluded yet -- an
 * honest gap, not a fabricated result. Stream C's five page-scope stages are likewise
 * absent until `sync/pages/index.ts` exists; every non-`full` scope reads as one skipped
 * stage until then.
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
import type { SyncStageFn } from './run.js';
import type { SyncStageName } from '../../shared/sync-contract.js';
import { writeWatcherState, type JiraWatcher } from './watcher-state.js';

export interface ProductionSyncDeps {
  queueStore: QueueStore;
  watcher: JiraWatcher;
  journal: Journal;
}

export function buildProductionSyncStages(deps: ProductionSyncDeps): Partial<Record<SyncStageName, SyncStageFn>> {
  return {
    'stop-workers': async () => {
      const fleet = new Fleet(new Lanes(lanesDir()), new Registry(registryDir()), journalPath(), killSwitchPath());
      const result = await fleet.stopAll('sync full: stopping running workers');
      return { counts: { stopped: result.stopped.length, stale: result.stale.length } };
    },

    'wipe-queue': async () => {
      const count = deps.queueStore.wipe(deps.journal);
      return { counts: { wiped: count } };
    },

    'reset-watermarks': async () => {
      const deleted = resetWatermarks(join(forgeHome(), 'intake'));
      return { counts: { reset: deleted.length } };
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
        feed, store: deps.queueStore, briefsDir: intakeBriefsDir(), shippedKeys: [], journal: deps.journal,
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
  };
}
