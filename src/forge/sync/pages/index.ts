/**
 * The board's per-page re-sync functions and their production wiring. Each export is a
 * `() => Promise<StageResult>` the sync runner (stream A) exposes as `POST /sync/<scope>`;
 * `buildPageDeps` is the one place that binds them to real collaborators rather than the
 * fakes the tests use.
 */
import { AccountsService, diskWriters, fleetLoginDir, realProbe } from '../../accounts-service.js';
import { accountsRegistryPath, liveRunsByAccount, loadAccounts } from '../../accounts.js';
import { processAlive } from '../../registry.js';
import { readAccountUsage } from '../../accounts-usage.js';
import type { InboxIssue } from '../../intake/inbox.js';
import { classifyInbox, fetchInboxIssues } from '../../intake/inbox.js';
import { probeJira } from '../../intake/jira.js';
import { Journal, replay } from '../../journal.js';
import { buildMachineSnapshot } from '../../machine/snapshot.js';
import { fleetConfigDirChoice, journalPath } from '../../paths.js';
import { jiraConfigFromEnv } from '../../queue-wire.js';
import { sweepAndCollectLocks, worktreeStatusFor } from '../../sessions/cleanup.js';
import { probeAlivePidLiveness, scanSessions } from '../../sessions/registry.js';
import { realProcessTable } from '../../service/process-table.js';

import { syncAccounts } from './accounts.js';
import { syncInbox } from './inbox.js';
import { syncLanes } from './lanes.js';
import { syncMachine } from './machine.js';
import { syncSessions, type StageResult } from './sessions.js';

export { syncAccounts, scheduleAccountsProbeTick } from './accounts.js';
export { syncInbox } from './inbox.js';
export { syncLanes } from './lanes.js';
export { syncMachine } from './machine.js';
export { syncSessions } from './sessions.js';
export type { StageResult } from './sessions.js';

export interface PageDepsInput {
  /** The whole-machine registry `cli.ts` already owns, for the Accounts probe's
   *  live-run attribution -- never re-read here. */
  registry: { all(): Array<{ pid: number; goal: string }> };
  consoleReads: {
    lanesResponse(): { lanes: Array<{ id: string }> };
    runRecheckResponse(id: string): Promise<unknown>;
  };
}

export interface PageDeps {
  sessions(): Promise<StageResult>;
  accounts(): Promise<StageResult>;
  machine(): Promise<StageResult>;
  inbox(): Promise<StageResult>;
  lanes(): Promise<StageResult>;
}

/** Binds every page's re-sync to the real, non-injected production collaborators the
 *  contract names -- this is the only place in this stream any of them is called for
 *  real; every test drives the pure `sync*` functions above through fakes instead. */
export function buildPageDeps(input: PageDepsInput): PageDeps {
  const path = journalPath();

  const accountsService = new AccountsService({
    loadAccounts: () => loadAccounts(accountsRegistryPath()),
    readUsage: () => readAccountUsage(),
    recordReading: diskWriters.recordReading,
    recordReadError: diskWriters.recordReadError,
    liveRuns: () => liveRunsByAccount(
      replay(path).events,
      input.registry.all().filter((row) => processAlive(row.pid)).map((row) => row.goal),
    ),
    fleetConfigDir: fleetLoginDir(() => fleetConfigDirChoice().dir),
    probe: realProbe(),
  });

  return {
    sessions: async () => {
      // `Journal.close()` is not optional (journal.ts:224): a handle left open keeps
      // the file locked against a reader in this same process on Windows. Every other
      // per-call `Journal` in this codebase (queue-wire.ts:168-176) is wrapped the same
      // way.
      const sessionsJournal = new Journal(path);
      try {
        return await syncSessions({
          scan: () => scanSessions({ probeAlivePid: probeAlivePidLiveness }),
          fold: () => replay(path),
          ingest: {
            append: (row) => sessionsJournal.append(row),
            lastStopFor: (sessionId) => replay(path).sessions[sessionId]?.lastStop,
            sweep: () => sweepAndCollectLocks(),
            worktreeStatusFor: (sessionId, cwd) => worktreeStatusFor(sessionId, cwd),
          },
          sweep: async () => JSON.stringify(sweepAndCollectLocks()),
        });
      } finally {
        sessionsJournal.close();
      }
    },
    accounts: () => syncAccounts({
      refreshAll: () => accountsService.refreshAll(),
      list: () => accountsService.list(),
    }),
    machine: () => syncMachine({
      snapshot: async () => {
        const rows = realProcessTable();
        const fleet = replay(path);
        const sessions = Object.values(fleet.sessions)
          .filter((session) => session.status === 'live')
          .map((session) => ({
            sessionId: session.sessionId, pid: session.pid, name: session.name,
            repo: session.repo ?? null, branch: session.branch ?? null,
            status: session.status, startedAt: session.startedAt,
          }));
        const snapshot = buildMachineSnapshot(sessions, rows, Date.now());
        return { sessions: snapshot.counts.sessions, processes: snapshot.counts.processes };
      },
    }),
    inbox: () => {
      // Scoped to this one call, not to `buildPageDeps` itself: `classifyInbox` needs
      // the caller's Jira accountId (`me`) and only a network probe can supply it, and
      // `syncInbox`'s own contract keeps `classify` synchronous, so the probe happens
      // once, during `fetch`. A variable shared across every `inbox()` call would let
      // two overlapping syncs (an auto-tick racing a manual click) classify with
      // whichever fetch's accountId landed last.
      let inboxAccountId = '';
      return syncInbox({
        fetch: async () => {
          const config = jiraConfigFromEnv();
          if (!config) throw new Error('inbox sync failed: missing FORGE_JIRA_SITE/EMAIL/TOKEN');
          const probe = await probeJira(config);
          if (!probe.ok) throw new Error(`inbox sync failed: could not identify the current user (HTTP ${probe.status})`);
          inboxAccountId = probe.accountId ?? '';
          return fetchInboxIssues({ ...config, days: 7 });
        },
        classify: (issues) => {
          const buckets = classifyInbox(issues as InboxIssue[], { accountId: inboxAccountId }, Date.now());
          // No single Jira status maps cleanly onto {open, resolved, dropped}: this reuses
          // classifyInbox's real three buckets rather than reading `status` a second way --
          // needsReply is still-open work, awaitingOthers is off my queue (resolved from my
          // side), statusDrift is tracking that fell out of sync with reality (dropped).
          return { open: buckets.needsReply.length, resolved: buckets.awaitingOthers.length, dropped: buckets.statusDrift.length };
        },
      });
    },
    lanes: () => syncLanes({
      lanes: () => input.consoleReads.lanesResponse().lanes,
      recheck: async (id) => {
        // `runRecheckResponse` reports the lane's fresh summary, not a changed/unchanged
        // flag -- a resync's job is making sure the read happened, so any recheck that
        // resolves without throwing counts as a change; one that throws (a GitHub read
        // failure) counts as failed, never as changed.
        await input.consoleReads.runRecheckResponse(id);
        return true;
      },
    }),
  };
}
