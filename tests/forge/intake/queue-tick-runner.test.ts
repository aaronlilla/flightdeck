/**
 * R-81: the queue loop cannot stop silently.
 *
 * Three properties, one per work item in `.claude/goals/2026-09-11-queue-tick-liveness.md`:
 * a pass that throws is recorded and the next interval still fires; a loop that has not
 * finished a pass in three intervals says so in plain English; and a pass over a held item
 * still proves the loop ran without writing a row per item per tick.
 *
 * The last group drives the real `runQueueTick` over a real `QueueStore`, not a stub: the
 * early return that keeps a held item quiet (`queue.ts`, `if (item.reason === reason)`) is
 * the thing under test, so a fake tick standing in for it would prove nothing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainGh, ChainLauncher, ChainRunStatus } from '../../../src/forge/chain.js';
import { runQueueTick, type QueueRuntimeDeps } from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { QueueTickRunner } from '../../../src/forge/intake/queueTickRunner.js';
import { QueueTickBackoff } from '../../../src/forge/queue-backoff.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

function fakeJournal(): { events: Record<string, unknown>[]; append: (row: Record<string, unknown>) => void } {
  const events: Record<string, unknown>[] = [];
  return { events, append: (row) => { events.push(row); } };
}

/** A clock the test moves by hand. Nothing here waits on a real timer. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

const INTERVAL = 15_000;

describe('QueueTickRunner: a pass that throws does not end the loop (item 1)', () => {
  it('records the failure with its message and is called again on the next interval', async () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    let calls = 0;
    const runner = new QueueTickRunner<string>({
      tick: async () => { calls += 1; throw new Error('cannot reach Jira'); },
      items: () => ['one'],
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    runner.tick();
    await runner.whenIdle();
    clock.advance(INTERVAL);
    runner.tick();
    await runner.whenIdle();

    expect(calls).toBe(2);
    expect(journal.events.filter((row) => row['event'] === 'queue.tick-error')).toMatchObject([
      { event: 'queue.tick-error', actor: 'queue', message: 'cannot reach Jira' },
    ]);
  });

  it('survives a synchronous throw out of the callback body, which a bare timer would not', async () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    let calls = 0;
    let blowUp = true;
    const runner = new QueueTickRunner<string>({
      tick: async () => { calls += 1; },
      items: () => ['one'],
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now }),
      intervalMs: INTERVAL,
      now: clock.now,
      before: () => {
        if (blowUp) { blowUp = false; throw new Error('the reply read blew up'); }
      },
    });

    expect(() => { runner.tick(); }).not.toThrow();
    await runner.whenIdle();
    expect(journal.events).toMatchObject([
      { event: 'queue.tick-error', message: 'the reply read blew up' },
    ]);

    clock.advance(INTERVAL);
    runner.tick();
    await runner.whenIdle();
    expect(calls).toBe(1);
  });

  it('records at most one row per run of consecutive identical failures', async () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    const runner = new QueueTickRunner<string>({
      tick: async () => { throw new Error('cannot reach Jira'); },
      items: () => [],
      journal,
      // A generous threshold so the backoff's own pause row cannot be mistaken for the
      // deduplication under test here.
      backoff: new QueueTickBackoff(journal, { now: clock.now, threshold: 99 }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    for (let i = 0; i < 5; i += 1) {
      runner.tick();
      await runner.whenIdle();
      clock.advance(INTERVAL);
    }

    expect(journal.events.filter((row) => row['event'] === 'queue.tick-error')).toHaveLength(1);
  });

  it('starts a new run of failures when the message changes', async () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    let message = 'cannot reach Jira';
    const runner = new QueueTickRunner<string>({
      tick: async () => { throw new Error(message); },
      items: () => [],
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now, threshold: 99 }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    runner.tick();
    await runner.whenIdle();
    message = 'the worktree is gone';
    runner.tick();
    await runner.whenIdle();

    expect(journal.events.map((row) => row['message'])).toEqual([
      'cannot reach Jira', 'the worktree is gone',
    ]);
  });
});

describe('QueueTickRunner: a stopped loop is visible without reading records (item 2)', () => {
  it('reads overdue and names the gap after four intervals with no completed pass', () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    const runner = new QueueTickRunner<string>({
      // Never resolves: the pass is in flight forever, which is what a hung hop looks
      // like from outside and is the case a journal replay cannot see either.
      tick: () => new Promise<void>(() => {}),
      items: () => [],
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    runner.tick();
    clock.advance(INTERVAL * 4);

    const status = runner.status();
    expect(status.overdue).toBe(true);
    expect(status.lastCompletedAt).toBeNull();
    expect(status.sinceLastCompletedSeconds).toBe(60);
    expect(status.sentence).toContain('1 minute');
    expect(status.sentence).toContain('has not finished a pass');
  });

  it('does not read overdue immediately after a completed pass', async () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    const runner = new QueueTickRunner<string>({
      tick: async () => {},
      items: () => [],
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    clock.advance(INTERVAL * 4);
    runner.tick();
    await runner.whenIdle();

    const status = runner.status();
    expect(status.overdue).toBe(false);
    expect(status.lastOutcome).toBe('ok');
    expect(status.lastCompletedAt).toBe(clock.now());
    expect(status.sentence).toBe('The queue loop finished a pass 0 seconds ago.');
  });

  it('reads overdue while every pass is failing, not healthy (critique finding, 2026-09-11)', async () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    const runner = new QueueTickRunner<string>({
      tick: async () => { throw new Error('the worktree is gone'); },
      items: () => [],
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now, threshold: 99 }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    for (let i = 0; i < 4; i += 1) {
      runner.tick();
      await runner.whenIdle();
      clock.advance(INTERVAL);
    }

    const status = runner.status();
    // A pass that threw is not a pass that ran. Stamping it as one would leave a loop
    // doing no work at all reading healthy forever.
    expect(status.lastCompletedAt).toBeNull();
    expect(status.overdue).toBe(true);
    expect(status.lastOutcome).toBe('failed');
    expect(status.lastError).toBe('the worktree is gone');
  });

  it('keeps saying the passes failed once the backoff starts dripping', async () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    const backoff = new QueueTickBackoff(journal, { now: clock.now, threshold: 2, dripMs: 600_000 });
    const runner = new QueueTickRunner<string>({
      tick: async () => { throw new Error('cannot reach Jira'); },
      items: () => [],
      journal,
      backoff,
      intervalMs: INTERVAL,
      now: clock.now,
    });

    for (let i = 0; i < 2; i += 1) {
      runner.tick();
      await runner.whenIdle();
      clock.advance(INTERVAL);
    }
    expect(backoff.isPaused).toBe(true);

    // The next intervals are refused by the drip. That must not rewrite the failure.
    clock.advance(INTERVAL * 2);
    runner.tick();
    await runner.whenIdle();

    const status = runner.status();
    expect(status.paused).toBe(true);
    expect(status.lastOutcome).toBe('failed');
    expect(status.overdue).toBe(true);
    expect(status.sentence).toContain('every pass since has failed');
  });

  it('says nothing that identifies an item, a run or a machine', () => {
    const journal = fakeJournal();
    const clock = fakeClock();
    const runner = new QueueTickRunner<string>({
      tick: () => new Promise<void>(() => {}),
      items: () => ['Q-c578de30'],
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    runner.tick();
    clock.advance(INTERVAL * 10);

    const sentence = runner.status().sentence;
    expect(sentence).not.toMatch(/Q-[0-9a-f]{8}|BBZ-\d+|[0-9a-f]{7,}|\bpid\b|\d{10,}/);
  });
});

describe('QueueTickRunner: a held item still proves the loop ran (item 3)', () => {
  function heldStore(): QueueStore {
    const dir = mkdtempSync(join(tmpdir(), 'queue-tick-runner-'));
    const store = new QueueStore(join(dir, 'queue.jsonl'));
    appendHeld(store, 'q1', 'A-1');
    return store;
  }

  /** A queued item already holding on an `after` gate that never resolves, its reason
   *  already written. `queue.ts` then returns it unchanged every tick and writes nothing:
   *  the silence this goal is about. */
  function appendHeld(store: QueueStore, id: string, input: string): void {
    store.append({
      id, at: 1000, source: 'ticket', ticket: input, input, repo: 'owner/name',
      briefPath: null, branch: null, worktreePath: null, base: null,
      state: 'queued', reason: 'waiting on unknown item: nonexistent-slug',
      after: ['nonexistent-slug'],
      runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    } as Partial<QueueItem> as never);
  }

  function buildDeps(store: QueueStore, events: Record<string, unknown>[]): QueueRuntimeDeps {
    const launcher: ChainLauncher = {
      provision: async ({ ticket }) => ({
        worktreePath: `C:/worktrees/repo--${ticket.toLowerCase()}`, branch: `feature/${ticket.toLowerCase()}`, base: 'develop',
      }),
      launch: async ({ ticket }) => ({ runKey: ticket.toLowerCase() }),
      status: async (): Promise<ChainRunStatus> => ({ finished: false }),
      runRegistered: async () => false,
    };
    const gh: ChainGh = { findPrByHead: async () => undefined };
    let seq = 0;
    return {
      planner: {
        planTicket: async (ticket) => ({ ticket, repo: 'owner/name', briefPath: `C:/briefs/${ticket}.md` }),
        planBrief: async () => ({ ticket: 'BRIEF-1', repo: 'owner/name', briefPath: 'C:/briefs/brief-1.md' }),
      },
      launcher,
      gh,
      council: async () => ({ verdict: 'PASS' }),
      gate: async () => ({ merged: false }),
      branchMerged: async () => false,
      clock: () => 1_000,
      killSwitch: () => false,
      paused: () => false,
      maxInFlight: () => 5,
      append: (event) => { seq += 1; events.push({ id: `e${seq}`, ...event }); return { id: `e${seq}` }; },
      store,
    } as QueueRuntimeDeps;
  }

  it('writes no per-item record over ten passes, and at most one completion record a minute', async () => {
    const store = heldStore();
    const queueEvents: Record<string, unknown>[] = [];
    const deps = buildDeps(store, queueEvents);
    const journal = fakeJournal();
    const clock = fakeClock();
    const runner = new QueueTickRunner<QueueItem>({
      tick: (items) => runQueueTick(deps, items).then(() => undefined),
      items: () => store.all(),
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    for (let i = 0; i < 10; i += 1) {
      runner.tick();
      await runner.whenIdle();
      clock.advance(INTERVAL);
    }

    // The real tick stayed silent about the held item, exactly as before this change.
    expect(queueEvents).toEqual([]);
    // Ten passes span two and a half minutes, so at most three completion rows: one a
    // minute is the ceiling, and a row per pass would be ten.
    const complete = journal.events.filter((row) => row['event'] === 'queue.tick-complete');
    expect(complete.length).toBeGreaterThanOrEqual(1);
    expect(complete.length).toBeLessThanOrEqual(3);
    expect(complete[0]).toMatchObject({ event: 'queue.tick-complete', actor: 'queue', considered: 1 });
  });

  it('records at once when the number of items considered changes', async () => {
    const store = heldStore();
    const queueEvents: Record<string, unknown>[] = [];
    const deps = buildDeps(store, queueEvents);
    const journal = fakeJournal();
    const clock = fakeClock();
    const runner = new QueueTickRunner<QueueItem>({
      tick: (items) => runQueueTick(deps, items).then(() => undefined),
      items: () => store.all(),
      journal,
      backoff: new QueueTickBackoff(journal, { now: clock.now }),
      intervalMs: INTERVAL,
      now: clock.now,
    });

    runner.tick();
    await runner.whenIdle();
    clock.advance(INTERVAL);
    runner.tick();
    await runner.whenIdle();
    expect(journal.events.filter((row) => row['event'] === 'queue.tick-complete')).toHaveLength(1);

    appendHeld(store, 'q2', 'A-2');
    clock.advance(INTERVAL);
    runner.tick();
    await runner.whenIdle();

    const complete = journal.events.filter((row) => row['event'] === 'queue.tick-complete');
    expect(complete).toHaveLength(2);
    expect(complete[1]).toMatchObject({ considered: 2 });
  });
});
