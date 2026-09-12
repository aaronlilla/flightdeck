/**
 * Items 1 and 2 of the pipeline-hardening brief (2026-09-11).
 *
 * 1. A parked item never recovers: fourteen call sites write `state: 'parked'` and the
 *    only exit is `retryItem`, which a person calls. An item parked on checks that were
 *    pending, whose checks then went green, sat there until somebody typed a retry.
 * 2. A retry can launch a second worker onto a live worktree: `relaunchOnRetryOrPark`
 *    clears `runKey` and relaunches whether or not the first worker's process is alive.
 *
 * Every dependency is a fake, the same shape `queue.test.ts` builds. The park reasons
 * used here are the literal strings `advanceItem` writes, not invented text.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainCouncilFn, ChainGateFn, ChainGh, ChainLauncher, ChainRunStatus } from '../../../src/forge/chain.js';
import {
  addTicketItem, advanceItem, retryItem, runQueueTick,
  type QueuePlanner, type QueueRuntimeDeps,
} from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';

function tempStore(): QueueStore {
  const dir = mkdtempSync(join(tmpdir(), 'queue-recovery-'));
  return new QueueStore(join(dir, 'queue.jsonl'));
}

interface Overrides {
  planner?: Partial<QueuePlanner>;
  launcher?: Partial<ChainLauncher>;
  gh?: Partial<ChainGh>;
  council?: ChainCouncilFn;
  gate?: ChainGateFn;
  checksConclusion?: QueueRuntimeDeps['checksConclusion'];
  runPid?: QueueRuntimeDeps['runPid'];
  maxInFlight?: () => number;
}

function buildDeps(store: QueueStore, overrides: Overrides = {}): { deps: QueueRuntimeDeps; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  const deps: QueueRuntimeDeps = {
    planner: {
      planTicket: async (ticket) => ({ ticket, repo: 'owner/name', briefPath: `C:/briefs/${ticket}.md` }),
      planBrief: async () => ({ ticket: 'BRIEF-1', repo: 'owner/name', briefPath: 'C:/briefs/brief-1.md' }),
      ...overrides.planner,
    },
    launcher: {
      provision: async ({ ticket }) => ({
        worktreePath: `C:/worktrees/repo--${ticket.toLowerCase()}`, branch: `feature/${ticket.toLowerCase()}`, base: 'develop',
      }),
      launch: async ({ ticket }) => ({ runKey: ticket.toLowerCase() }),
      status: async (): Promise<ChainRunStatus> => ({ finished: false }),
      runRegistered: async () => false,
      ...overrides.launcher,
    },
    gh: { findPrByHead: async () => undefined, ...overrides.gh },
    council: overrides.council ?? (async () => ({ verdict: 'PASS' })),
    gate: overrides.gate ?? (async () => ({ merged: false })),
    clock: () => 1_000,
    killSwitch: () => false,
    paused: () => false,
    maxInFlight: overrides.maxInFlight ?? (() => 2),
    append: (event) => {
      seq += 1;
      const id = `e${seq}`;
      events.push({ id, ...event });
      return { id };
    },
    store,
    ...(overrides.checksConclusion ? { checksConclusion: overrides.checksConclusion } : {}),
    ...(overrides.runPid ? { runPid: overrides.runPid } : {}),
  };
  return { deps, events };
}

/** An item parked with the literal reason `advanceItem` writes for the given hop. */
function parkedItem(store: QueueStore, reason: string, extra: Record<string, unknown> = {}) {
  const item = addTicketItem(store, 'ABC-1', 1_000);
  store.append({
    id: item.id, at: 1_000, updatedAt: 1_000, state: 'parked', reason,
    repo: 'owner/name', pr: { no: 7, url: 'https://github.com/owner/name/pull/7', draft: true },
    branch: 'feature/abc-1', worktreePath: 'C:/worktrees/repo--abc-1', base: 'develop',
    briefPath: 'C:/briefs/ABC-1.md', ticket: 'ABC-1',
    ...extra,
  });
  return store.get(item.id)!;
}

describe('item 1: a parked item recovers on its own when the park reason was transient', () => {
  it('advances an item parked on checks that have since gone green, with no human call', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'checks never settled after 20 polls');
    const { deps, events } = buildDeps(store, { checksConclusion: async () => 'SUCCESS' });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).not.toBe('parked');
    const row = events.find((e) => e['event'] === 'queue.recovered');
    expect(row).toMatchObject({ itemId: item.id, reRead: 'checks', found: 'SUCCESS' });
  });

  it('leaves an item parked on a merge conflict alone, and its row says why', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'conflicts with develop: the branch could not be replayed on its base');
    const { deps, events } = buildDeps(store, { checksConclusion: async () => 'SUCCESS' });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).toBe('parked');
    const row = events.find((e) => e['event'] === 'queue.recovery-declined');
    expect(row).toMatchObject({ itemId: item.id });
    expect(String(row!['why'])).toMatch(/conflict/i);
  });

  it('holds an item whose checks are still failing, and stops after a bounded number of attempts', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'checks never settled after 20 polls');
    const { deps, events } = buildDeps(store, { checksConclusion: async () => 'FAILURE' });

    for (let tick = 0; tick < 5; tick += 1) await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).toBe('parked');
    const held = events.filter((e) => e['event'] === 'queue.recovery-held');
    expect(held).toHaveLength(3);
    expect(held[0]).toMatchObject({ itemId: item.id, reRead: 'checks', found: 'FAILURE' });
  });

  it('holds when no checks reader is wired rather than guessing the checks are green', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'checks never settled after 20 polls');
    const { deps, events } = buildDeps(store);

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).toBe('parked');
    expect(events.find((e) => e['event'] === 'queue.recovery-held')).toMatchObject({ found: 'no checks reader wired' });
  });

  it('recovers a run that finished with no PR once its process is gone', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'stopped', { runKey: 'abc-1' });
    const { deps, events } = buildDeps(store, { runPid: () => undefined });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).not.toBe('parked');
    expect(events.find((e) => e['event'] === 'queue.recovered')).toMatchObject({ reRead: 'run', found: 'no live process' });
  });

  it('does not recover a run whose process is still alive', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'stopped', { runKey: 'abc-1' });
    const { deps, events } = buildDeps(store, { runPid: () => 4242 });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).toBe('parked');
    expect(events.find((e) => e['event'] === 'queue.recovery-held')).toMatchObject({ found: 'run still alive (pid 4242)' });
  });
});

describe('item 2: a retry never launches a second worker onto a live worktree', () => {
  it('refuses to relaunch while the first run process is alive, and names the pid', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'stopped', { runKey: 'abc-1' });
    retryItem(store, item.id, 2_000);
    const launches: string[] = [];
    const { deps, events } = buildDeps(store, {
      runPid: () => 4242,
      launcher: {
        status: async (): Promise<ChainRunStatus> => ({ finished: true, verdict: 'stopped' }),
        launch: async ({ ticket }) => { launches.push(ticket); return { runKey: ticket.toLowerCase() }; },
      },
    });

    await advanceItem(store.get(item.id)!, deps);

    expect(launches).toEqual([]);
    expect(events.find((e) => e['event'] === 'queue.relaunch-refused')).toMatchObject({ itemId: item.id, pid: 4242 });
    expect(store.get(item.id)!.runKey).toBe('abc-1');
  });

  it('relaunches once the process is gone', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'stopped', { runKey: 'abc-1' });
    retryItem(store, item.id, 2_000);
    const { deps, events } = buildDeps(store, {
      runPid: () => undefined,
      launcher: { status: async (): Promise<ChainRunStatus> => ({ finished: true, verdict: 'stopped' }) },
    });

    await advanceItem(store.get(item.id)!, deps);

    expect(events.find((e) => e['event'] === 'queue.relaunch-on-retry')).toBeTruthy();
    expect(events.find((e) => e['event'] === 'queue.relaunch-refused')).toBeUndefined();
  });

  it('relaunches when no liveness reader is wired at all, as it did before this guard', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'stopped', { runKey: 'abc-1' });
    retryItem(store, item.id, 2_000);
    const { deps, events } = buildDeps(store, {
      launcher: { status: async (): Promise<ChainRunStatus> => ({ finished: true, verdict: 'stopped' }) },
    });

    await advanceItem(store.get(item.id)!, deps);

    expect(events.find((e) => e['event'] === 'queue.relaunch-on-retry')).toBeTruthy();
  });
});
