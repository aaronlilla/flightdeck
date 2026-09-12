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
  addTicketItem, advanceItem, retryItem, runQueueTick, PARK_CHECKS_RECHECK_CAP,
  type QueuePlanner, type QueueRuntimeDeps,
} from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { conclusionOf } from '../../../src/forge/council/gh.js';

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
  clock?: () => number;
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
    clock: overrides.clock ?? (() => 1_000),
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
    // The value the SHIPPED reader produces, from the shipped function that produces it:
    // the wiring returns `REAL_GH.viewPr(...).checks.conclusion`, which is `conclusionOf`'s
    // own answer. A literal chosen here proved nothing -- the first cut of this test fed
    // 'SUCCESS' and the recovery compared against 'SUCCESS', while the real wiring has
    // always answered 'success', so the whole branch was dead in production.
    const green = conclusionOf([{ conclusion: 'SUCCESS' }]);
    const { deps, events } = buildDeps(store, { checksConclusion: async () => green });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).not.toBe('parked');
    const row = events.find((e) => e['event'] === 'queue.recovered');
    expect(row).toMatchObject({ itemId: item.id, reRead: 'checks', found: green });
  });

  it('leaves an item parked on a merge conflict alone, and its row says why', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'conflicts with develop: the branch could not be replayed on its base');
    const { deps, events } = buildDeps(store, { checksConclusion: async () => conclusionOf([{ conclusion: 'SUCCESS' }]) });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).toBe('parked');
    const row = events.find((e) => e['event'] === 'queue.recovery-declined');
    expect(row).toMatchObject({ itemId: item.id });
    expect(String(row!['why'])).toMatch(/conflict/i);
  });

  it('holds an item whose checks are still failing, journalling the hold once per distinct reading', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'checks never settled after 20 polls');
    const red = conclusionOf([{ conclusion: 'FAILURE' }]);
    const { deps, events } = buildDeps(store, { checksConclusion: async () => red });

    for (let tick = 0; tick < 5; tick += 1) await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).toBe('parked');
    const held = events.filter((e) => e['event'] === 'queue.recovery-held');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ itemId: item.id, reRead: 'checks', found: red });
  });

  it('still recovers after holding far longer than the recovery budget', async () => {
    // The tick runs every 15 seconds by default, so a budget spent on "not yet" answers
    // is 45 seconds of wall clock. A worker that outlived its own retry click by a minute
    // used to lose that retry for good.
    const store = tempStore();
    const item = parkedItem(store, 'retry refused: abc-1 is still running as pid 4242', { runKey: 'abc-1' });
    let pid: number | undefined = 4242;
    const { deps, events } = buildDeps(store, { runPid: () => pid });

    for (let tick = 0; tick < 20; tick += 1) await runQueueTick(deps, store.all());
    expect(store.get(item.id)!.state).toBe('parked');

    pid = undefined;
    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).not.toBe('parked');
    expect(events.filter((e) => e['event'] === 'queue.recovery-held')).toHaveLength(1);
  });

  it('gives up after three RECOVERIES of one item, and says so rather than going quiet', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'stopped', { runKey: 'abc-1' });
    const { deps, events } = buildDeps(store, { runPid: () => undefined });

    for (let round = 0; round < 5; round += 1) {
      store.append({ id: item.id, at: 1_000, state: 'parked', reason: 'stopped', updatedAt: 1_000 });
      await runQueueTick(deps, store.all());
    }

    expect(events.filter((e) => e['event'] === 'queue.recovered')).toHaveLength(3);
    const declined = events.filter((e) => e['event'] === 'queue.recovery-declined');
    expect(declined).toHaveLength(1);
    expect(String(declined[0]!['why'])).toMatch(/recovered/i);
    expect(store.get(item.id)!.state).toBe('parked');
  });

  it('recovers the finished-with-no-PR park the gate hop writes', async () => {
    const store = tempStore();
    const reason = 'run finished done but no PR was found in its evidence or on its branch';
    const item = parkedItem(store, reason, { runKey: 'abc-1' });
    const { deps } = buildDeps(store, { runPid: () => undefined });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).not.toBe('parked');
  });

  it('leaves an exhausted run parked: a budget ceiling is not a stale reading', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'exhausted', { runKey: 'abc-1' });
    const { deps } = buildDeps(store, { runPid: () => undefined });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).toBe('parked');
  });

  it('recovers no more items in one tick than the width leaves room for', async () => {
    const store = tempStore();
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const row = addTicketItem(store, `ABC-${n + 2}`, 1_000);
      store.append({
        id: row.id, at: 1_000, updatedAt: 1_000, state: 'parked', reason: 'stopped',
        repo: 'owner/name', runKey: `run-${n}`, briefPath: 'C:/briefs/x.md', ticket: `ABC-${n + 2}`,
      });
      ids.push(row.id);
    }
    const { deps } = buildDeps(store, { runPid: () => undefined, maxInFlight: () => 2 });

    await runQueueTick(deps, store.all());

    const moved = ids.filter((id) => store.get(id)!.state !== 'parked');
    expect(moved).toHaveLength(2);
  });

  it('says so when the width is what held an item back, rather than skipping it in silence', async () => {
    const store = tempStore();
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const row = addTicketItem(store, `ABC-${n + 2}`, 1_000);
      store.append({
        id: row.id, at: 1_000, updatedAt: 1_000, state: 'parked', reason: 'stopped',
        repo: 'owner/name', runKey: `run-${n}`, briefPath: 'C:/briefs/x.md', ticket: `ABC-${n + 2}`,
      });
      ids.push(row.id);
    }
    const { deps, events } = buildDeps(store, { runPid: () => undefined, maxInFlight: () => 2 });

    await runQueueTick(deps, store.all());
    await runQueueTick(deps, store.all());

    const deferred = events.filter((e) => e['event'] === 'queue.recovery-held' && e['found'] === 'no room at this width');
    expect(deferred.length).toBeGreaterThanOrEqual(1);
  });

  it('relaunches the worker once a recovered run re-enters the worker, not only changing state', async () => {
    // Leaving `parked` is not the outcome; a relaunched worker is. Without this, every
    // run-path specimen here would pass even if `advanceItem` did nothing afterwards.
    const store = tempStore();
    const item = parkedItem(store, 'stopped', { runKey: 'abc-1' });
    const launches: string[] = [];
    const { deps } = buildDeps(store, {
      runPid: () => undefined,
      launcher: {
        status: async () => ({ finished: true, verdict: 'stopped' }),
        launch: async ({ ticket }) => { launches.push(ticket); return { runKey: ticket.toLowerCase() }; },
      },
    });

    await runQueueTick(deps, store.all());
    await advanceItem(store.get(item.id)!, deps);

    expect(launches).toEqual(['ABC-1']);
  });

  it('journals a second decline when a re-parked item lands on a different unrecoverable reason', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'unrouted');
    const { deps, events } = buildDeps(store);

    await runQueueTick(deps, store.all());
    store.append({ id: item.id, at: 2_000, state: 'parked', reason: 'overlaps Q-other on src/a.ts', updatedAt: 2_000 });
    await runQueueTick(deps, store.all());

    expect(events.filter((e) => e['event'] === 'queue.recovery-declined')).toHaveLength(2);
  });

  it('re-reads a pull request checks at most once per window, not once per tick', async () => {
    // The wired reader is a network call. The tick runs every 15 seconds and holds are
    // unbounded, so one call per tick per parked item is roughly 1,400 GitHub calls an
    // hour at width three, against a ceiling every session on this machine shares.
    const store = tempStore();
    parkedItem(store, 'checks never settled after 20 polls');
    let calls = 0;
    let now = 1_000;
    const { deps } = buildDeps(store, {
      checksConclusion: async () => { calls += 1; return conclusionOf([{ conclusion: 'FAILURE' }]); },
      clock: () => now,
    });

    for (let tick = 0; tick < 20; tick += 1) { now += 15_000; await runQueueTick(deps, store.all()); }

    expect(calls).toBeLessThanOrEqual(2);
  });

  it('stops re-reading checks after a bounded number of reads, and says so', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'checks never settled after 20 polls');
    let calls = 0;
    let now = 1_000;
    const { deps, events } = buildDeps(store, {
      checksConclusion: async () => { calls += 1; return conclusionOf([{ conclusion: 'FAILURE' }]); },
      clock: () => now,
    });

    for (let tick = 0; tick < 60; tick += 1) { now += 10 * 60_000; await runQueueTick(deps, store.all()); }

    expect(calls).toBeLessThanOrEqual(PARK_CHECKS_RECHECK_CAP);
    expect(store.get(item.id)!.state).toBe('parked');
    expect(events.some((e) => e['event'] === 'queue.recovery-declined')).toBe(true);
  });

  it('does not mark a checks recovery as a person asking for a relaunch', async () => {
    // `retriedAt` means "an operator asked for this run to be looked at again", and
    // `relaunchOnRetryOrPark` answers it by provisioning a brand-new worker. A check that
    // went green is not that: the run finished correctly and only the checks moved.
    const store = tempStore();
    const item = parkedItem(store, 'checks never settled after 20 polls', { runKey: 'abc-1' });
    const { deps } = buildDeps(store, { checksConclusion: async () => conclusionOf([{ conclusion: 'SUCCESS' }]) });

    await runQueueTick(deps, store.all());

    const row = store.get(item.id)!;
    expect(row.state).toBe('running');
    expect(row.retriedAt ?? null).toBeNull();
  });

  it('recovers the unverified verdict, which is the commonest one the park path writes', async () => {
    const store = tempStore();
    const item = parkedItem(store, 'unverified', { runKey: 'abc-1' });
    const { deps } = buildDeps(store, { runPid: () => undefined });

    await runQueueTick(deps, store.all());

    expect(store.get(item.id)!.state).not.toBe('parked');
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
