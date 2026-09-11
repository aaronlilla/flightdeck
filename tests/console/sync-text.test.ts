/**
 * Pure templates for the re-sync surfaces (R-71). Every branch gets two distinct
 * fixtures so a literal string standing in for the real render cannot pass.
 */
import { describe, expect, it } from 'vitest';

import { runSummary, stageLine, watcherLine } from '../../src/console/sync-text.js';
import type { SyncRunRecord, SyncStage, WatcherStatus } from '../../src/shared/sync-contract.js';

const POLL_A = new Date(2026, 8, 11, 7, 41, 0).getTime();
const POLL_B = new Date(2026, 8, 11, 9, 5, 0).getTime();

function watcher(extra: Partial<WatcherStatus> = {}): WatcherStatus {
  return { on: true, project: 'BBZ', pollSeconds: 30, lastPollAt: POLL_A, lastCount: 3, ...extra };
}

describe('watcherLine', () => {
  it('renders the on line with the project, last poll and a countdown', () => {
    const now = POLL_A + 12_000;
    expect(watcherLine(watcher(), now)).toBe('Watching BBZ · last poll 07:41 · 3 owned · next in 18 s');
  });

  it('renders a different on line for a different fixture (no literal can pass both)', () => {
    const now = POLL_B + 5_000;
    expect(watcherLine(watcher({ project: 'FLT', lastPollAt: POLL_B, lastCount: 11, pollSeconds: 20 }), now))
      .toBe('Watching FLT · last poll 09:05 · 11 owned · next in 15 s');
  });

  it('renders off', () => {
    expect(watcherLine(watcher({ on: false }), Date.now())).toBe('Watcher off');
  });

  it('renders off for a second fixture the same way (off ignores project/count)', () => {
    expect(watcherLine(watcher({ on: false, project: 'FLT', lastCount: 99 }), Date.now())).toBe('Watcher off');
  });

  it('renders the error line with the last error text', () => {
    expect(watcherLine(watcher({ lastError: 'Jira: 401 Unauthorized' }), Date.now())).toBe('Watcher error: Jira: 401 Unauthorized');
  });

  it('renders a different error line for a second fixture', () => {
    expect(watcherLine(watcher({ lastError: 'timed out after 10s' }), Date.now())).toBe('Watcher error: timed out after 10s');
  });
});

function stage(extra: Partial<SyncStage> = {}): SyncStage {
  return { name: 'fetch-repos', status: 'ok', startedAt: Date.now(), counts: { fetched: 3 }, ...extra };
}

describe('stageLine', () => {
  it('renders an ok stage with its counts', () => {
    expect(stageLine(stage())).toBe('fetch-repos · ok · 3 fetched');
  });

  it('renders a different ok stage for a second fixture', () => {
    expect(stageLine(stage({ name: 'sweep-worktrees', counts: { removed: 5, kept: 2 } })))
      .toBe('sweep-worktrees · ok · 5 removed, 2 kept');
  });

  it('renders a failed stage with its message', () => {
    expect(stageLine(stage({ name: 'reconcile-prs', status: 'failed', counts: {}, message: 'gh: rate limited' })))
      .toBe('reconcile-prs · failed · gh: rate limited');
  });

  it('renders a different failed stage for a second fixture', () => {
    expect(stageLine(stage({ name: 'pull-jira', status: 'failed', counts: {}, message: 'Jira: 401 Unauthorized' })))
      .toBe('pull-jira · failed · Jira: 401 Unauthorized');
  });

  it('renders a skipped stage with no counts or message', () => {
    expect(stageLine(stage({ name: 'pull-jira', status: 'skipped', counts: {} }))).toBe('pull-jira · skipped');
  });

  it('renders a different skipped stage for a second fixture', () => {
    expect(stageLine(stage({ name: 'watcher-on', status: 'skipped', counts: {} }))).toBe('watcher-on · skipped');
  });

  it('renders a running stage with no counts yet', () => {
    expect(stageLine(stage({ name: 'scan-sessions', status: 'running', counts: {} }))).toBe('scan-sessions · running');
  });

  it('renders a different running stage for a second fixture', () => {
    expect(stageLine(stage({ name: 'probe-accounts', status: 'running', counts: {} }))).toBe('probe-accounts · running');
  });
});

function run(extra: Partial<SyncRunRecord> = {}): SyncRunRecord {
  return {
    scope: 'lanes', id: 'r-1', startedAt: Date.now(), endedAt: Date.now() + 1000,
    stages: [stage()], ok: true, ...extra,
  };
}

describe('runSummary', () => {
  it('renders a null run as never synced', () => {
    expect(runSummary(null)).toBe('never synced');
  });

  it('renders an ok run', () => {
    expect(runSummary(run())).toBe('synced ok · 1 stage');
  });

  it('renders a different ok run with a different stage count', () => {
    expect(runSummary(run({ stages: [stage(), stage({ name: 'reconcile-prs' })] }))).toBe('synced ok · 2 stages');
  });

  it('renders a failed run naming the failed stage', () => {
    expect(runSummary(run({ ok: false, stages: [stage(), stage({ name: 'reconcile-prs', status: 'failed', counts: {}, message: 'gh: rate limited' })] })))
      .toBe('failed at reconcile-prs · gh: rate limited');
  });

  it('renders a different failed run for a second fixture', () => {
    expect(runSummary(run({ ok: false, stages: [stage({ name: 'pull-jira', status: 'failed', counts: {}, message: 'Jira: 401 Unauthorized' })] })))
      .toBe('failed at pull-jira · Jira: 401 Unauthorized');
  });

  it('renders a still-running run naming the running stage', () => {
    expect(runSummary(run({ ok: false, endedAt: undefined, stages: [stage({ status: 'ok' }), stage({ name: 'reconcile-prs', status: 'running', counts: {} })] })))
      .toBe('running · reconcile-prs');
  });

  it('renders a different still-running run for a second fixture', () => {
    expect(runSummary(run({ ok: false, endedAt: undefined, stages: [stage({ name: 'scan-sessions', status: 'running', counts: {} })] })))
      .toBe('running · scan-sessions');
  });
});
