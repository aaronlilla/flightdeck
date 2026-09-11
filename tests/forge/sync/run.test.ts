/**
 * R-68 item 4: the sync runner. Every stage is a plain injected fake; nothing here
 * touches git, gh, or a real console.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SyncStageName } from '../../../src/shared/sync-contract.js';
import { Journal } from '../../../src/forge/journal.js';
import { createSyncRunner, type SyncStageFn } from '../../../src/forge/sync/run.js';
import { SyncStore } from '../../../src/forge/sync/store.js';

function tempJournal(): Journal {
  return new Journal(join(mkdtempSync(join(tmpdir(), 'sync-run-journal-')), 'journal.jsonl'));
}

function tempStore(): SyncStore {
  return new SyncStore(join(mkdtempSync(join(tmpdir(), 'sync-run-store-')), 'sync.json'));
}

const FULL_ORDER: SyncStageName[] = [
  'stop-workers', 'wipe-queue', 'reset-watermarks',
  'fetch-repos', 'reconcile-prs', 'sweep-worktrees',
  'pull-jira', 'watcher-on', 'resume',
];

function okStage(name: string): SyncStageFn {
  return async () => ({ counts: { [name]: 1 } });
}

describe('createSyncRunner', () => {
  it('happy path: nine stages ok, in order, read back from the journal', async () => {
    const journal = tempJournal();
    const store = tempStore();
    const stages = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage(name)]));
    const runner = createSyncRunner({ stages, journal, store });

    const record = await runner.runSync('full');
    journal.close();

    expect(record.ok).toBe(true);
    expect(record.stages.map((s) => s.name)).toEqual(FULL_ORDER);
    expect(record.stages.every((s) => s.status === 'ok')).toBe(true);
  });

  it('a failure at reconcile-prs skips every later stage and never calls resume', async () => {
    const journal = tempJournal();
    const store = tempStore();
    let resumeCalled = false;
    const stages: Record<string, SyncStageFn> = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage(name)]));
    stages['reconcile-prs'] = async () => { throw new Error('gh rate limited'); };
    stages['resume'] = async () => { resumeCalled = true; return { counts: {} }; };
    const runner = createSyncRunner({ stages, journal, store });

    const record = await runner.runSync('full');
    journal.close();

    expect(record.ok).toBe(false);
    expect(resumeCalled).toBe(false);
    const byName = Object.fromEntries(record.stages.map((s) => [s.name, s.status]));
    expect(byName['reconcile-prs']).toBe('failed');
    expect(byName['sweep-worktrees']).toBe('skipped');
    expect(byName['pull-jira']).toBe('skipped');
    expect(byName['watcher-on']).toBe('skipped');
    expect(byName['resume']).toBe('skipped');
  });

  it('a failed run calls onFailure exactly once; a clean run never does', async () => {
    let calls = 0;
    const okStages = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage(name)]));
    const okRunner = createSyncRunner({ stages: okStages, journal: tempJournal(), store: tempStore(), onFailure: async () => { calls += 1; } });
    await okRunner.runSync('full');
    expect(calls).toBe(0);

    const badStages = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage(name)]));
    badStages['reconcile-prs'] = async () => { throw new Error('gh exploded'); };
    const badRunner = createSyncRunner({ stages: badStages, journal: tempJournal(), store: tempStore(), onFailure: async () => { calls += 1; } });
    const record = await badRunner.runSync('full');
    expect(record.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('an absent stage is skipped, never failed, and the run still reads ok', async () => {
    const journal = tempJournal();
    const store = tempStore();
    const stages: Record<string, SyncStageFn> = Object.fromEntries(
      FULL_ORDER.filter((name) => name !== 'pull-jira').map((name) => [name, okStage(name)]),
    );
    const runner = createSyncRunner({ stages, journal, store });

    const record = await runner.runSync('full');

    const pullJira = record.stages.find((s) => s.name === 'pull-jira');
    expect(pullJira?.status).toBe('skipped');
    expect(pullJira?.message).toBe('stage not configured: pull-jira');
    expect(record.ok).toBe(true);
    journal.close();
  });

  it('a second concurrent run of the same scope is refused', async () => {
    const journal = tempJournal();
    const store = tempStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stages: Record<string, SyncStageFn> = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage(name)]));
    stages['stop-workers'] = async () => { await gate; return { counts: {} }; };
    const runner = createSyncRunner({ stages, journal, store });

    const first = runner.runSync('full');
    expect(runner.isRunning('full')).toBe(true);
    await expect(runner.runSync('full')).rejects.toThrow(/already running/);

    release!();
    await first;
    journal.close();
  });

  it('a throw before the loop still releases the running guard (critique finding)', async () => {
    const journal = tempJournal();
    const store = tempStore();
    const stages = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage(name)]));
    let first = true;
    const runner = createSyncRunner({
      stages, journal, store,
      id: () => { if (first) { first = false; throw new Error('id generator exploded'); } return 'ok-id'; },
    });

    await expect(runner.runSync('full')).rejects.toThrow('id generator exploded');
    expect(runner.isRunning('full')).toBe(false);

    const record = await runner.runSync('full');
    expect(record.ok).toBe(true);
    journal.close();
  });

  it('persists the record and reads it back through the store', async () => {
    const journal = tempJournal();
    const store = tempStore();
    const stages = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage(name)]));
    const runner = createSyncRunner({ stages, journal, store });

    const record = await runner.runSync('full');
    journal.close();

    expect(store.get('full')).toEqual(record);
  });
});
