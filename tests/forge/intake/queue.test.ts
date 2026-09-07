/**
 * The intake queue's worker (`queue.ts`), against fakes for every dependency -- no
 * network call, no spawned process, no real git worktree, mirroring how
 * `tests/forge/chain/chain.test.ts` proves `chain.ts`. Every specimen builds its own
 * `QueueRuntimeDeps` plus a real `QueueStore` over a temp file (the store's own I/O is
 * cheap and deterministic, the same choice `tests/forge/console/proposals.test.ts` makes
 * for the fleet journal).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainCouncilFn, ChainGateFn, ChainGh, ChainLauncher, ChainRunStatus } from '../../../src/forge/chain.js';
import {
  addBacklogItems, addBriefItem, addQueryItems, addTicketItem, advanceItem, QUEUE_IN_FLIGHT_STATES, removeItem,
  retryItem, runQueueTick,
  type QueuePlanner, type QueueRuntimeDeps, type QueueTicketSearch,
} from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';

function tempStore(): QueueStore {
  const dir = mkdtempSync(join(tmpdir(), 'queue-'));
  return new QueueStore(join(dir, 'queue.jsonl'));
}

interface FixtureOverrides {
  planner?: Partial<QueuePlanner>;
  launcher?: Partial<ChainLauncher>;
  gh?: Partial<ChainGh>;
  rebaseOnBase?: QueueRuntimeDeps['rebaseOnBase'];
  council?: ChainCouncilFn;
  gate?: ChainGateFn;
  killSwitch?: () => boolean;
  paused?: () => boolean;
  maxInFlight?: number;
}

function buildDeps(store: QueueStore, overrides: FixtureOverrides = {}): { deps: QueueRuntimeDeps; events: Record<string, unknown>[] } {
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
    gh: {
      findPrByHead: async () => undefined,
      ...overrides.gh,
    },
    ...(overrides.rebaseOnBase ? { rebaseOnBase: overrides.rebaseOnBase } : {}),
    council: overrides.council ?? (async () => ({ verdict: 'PASS' })),
    gate: overrides.gate ?? (async () => ({ merged: false })),
    clock: () => 1_000,
    killSwitch: overrides.killSwitch ?? (() => false),
    paused: overrides.paused ?? (() => false),
    maxInFlight: overrides.maxInFlight ?? 2,
    append: (event) => {
      seq += 1;
      const id = `e${seq}`;
      events.push({ id, ...event });
      return { id };
    },
    store,
  };
  return { deps, events };
}

describe('addTicketItem / addBriefItem', () => {
  it('adds a queued item carrying the ticket as both input and ticket', () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    expect(item).toMatchObject({ source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', state: 'queued', repo: null });
    expect(store.all()).toEqual([item]);
  });

  it('adds a queued item for a pasted brief with no ticket yet', () => {
    const store = tempStore();
    const item = addBriefItem(store, '# Goal: fix the thing', 1000);
    expect(item).toMatchObject({ source: 'brief', input: '# Goal: fix the thing', ticket: null, state: 'queued' });
  });
});

describe('addQueryItems / addBacklogItems', () => {
  it('resolves a JQL query to one item per matching ticket', async () => {
    const store = tempStore();
    const search: QueueTicketSearch = { searchKeys: async () => ['ABC-1', 'ABC-2'] };
    const items = await addQueryItems(store, 'sprint = 42', search, 1000);
    expect(items.map((i) => i.ticket)).toEqual(['ABC-1', 'ABC-2']);
    expect(items.every((i) => i.source === 'query' && i.input === 'sprint = 42')).toBe(true);
  });

  it('adds nothing for a backlog filter matching no tickets', async () => {
    const store = tempStore();
    const search: QueueTicketSearch = { searchKeys: async () => [] };
    const items = await addBacklogItems(store, 'label = flaky', search, 1000);
    expect(items).toEqual([]);
    expect(store.all()).toEqual([]);
  });
});

describe('removeItem / retryItem', () => {
  it('removes an item from the visible list without erasing it from the raw log', () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    expect(removeItem(store, item.id, 2000)).toBe(true);
    expect(store.all()).toEqual([]);
    expect(removeItem(store, 'nope', 2000)).toBe(false);
  });

  it('sends a parked item back to queued, keeping its brief and repo', () => {
    const store = tempStore();
    store.append({
      id: 'q1', at: 1000, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: 'owner/name',
      briefPath: 'C:/briefs/abc-1.md', state: 'parked', reason: 'unrouted', runKey: null, pr: null,
      journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    const retried = retryItem(store, 'q1', 2000);
    expect(retried).toMatchObject({ state: 'queued', reason: null, briefPath: 'C:/briefs/abc-1.md', repo: 'owner/name' });
  });

  it('refuses to retry an item that is not parked or failed', () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    expect(retryItem(store, item.id, 2000)).toBeUndefined();
  });

  it('restores running, not queued, for an item retried with a run already in flight', () => {
    // Confirmed live on a real queue run 2026-09-06: a retried item whose runKey was
    // already set went back to 'queued' here, which QUEUE_IN_FLIGHT_STATES does not
    // count as in-flight. Every tick after that re-added the same item to
    // runQueueTick's advance list on top of the one already running, so the same PR
    // got a second, fully concurrent council/gate pass -- a second real Codex
    // subprocess for one item, spent for nothing.
    const store = tempStore();
    store.append({
      id: 'q1', at: 1000, source: 'brief', input: 'do the thing', ticket: 'q-brief-1', repo: 'owner/name',
      briefPath: 'C:/briefs/q-brief-1.md', branch: 'feature/q-brief-1', worktreePath: '/wt/q-brief-1', base: 'main',
      state: 'parked', reason: 'FIX FIRST', runKey: 'q-brief-1', pr: null,
      journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    const retried = retryItem(store, 'q1', 2000);
    expect(retried?.state).toBe('running');
    expect(QUEUE_IN_FLIGHT_STATES).toContain(retried?.state);
  });
});

describe('advanceItem', () => {
  it('walks a ticket item from queued through planned, launched, gated to review', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let statusCalls = 0;
    const { deps, events } = buildDeps(store, {
      launcher: {
        status: async () => {
          statusCalls += 1;
          return statusCalls < 2
            ? { finished: false }
            : { finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/42' };
        },
      },
    });

    const planned = await advanceItem(item, deps);
    expect(planned.state).toBe('running');
    expect(planned.briefPath).toBe('C:/briefs/ABC-1.md');
    expect(planned.runKey).toBeNull();

    const launched = await advanceItem(planned, deps);
    expect(launched.runKey).toBe('abc-1');
    expect(launched.branch).toBe('feature/abc-1');

    const stillWaiting = await advanceItem(launched, deps);
    expect(stillWaiting.state).toBe('running');
    expect(stillWaiting.runKey).toBe('abc-1');

    const reviewed = await advanceItem(stillWaiting, deps);
    expect(reviewed.state).toBe('review');
    expect(reviewed.pr).toMatchObject({ no: 42, url: 'https://github.com/owner/name/pull/42', draft: true });

    expect(store.get(item.id)?.state).toBe('review');
    expect(events.map((e) => e['event'])).toEqual([
      'queue.planning', 'queue.planned', 'queue.launched', 'queue.review',
    ]);
  });

  it('never asks the gate to merge, even when the council passes', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let gateInput: { repo: string; pr: number; merge: boolean } | undefined;
    const { deps } = buildDeps(store, {
      launcher: {
        status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }),
      },
      gate: async (input) => { gateInput = input; return { merged: false }; },
    });

    let current = item;
    current = await advanceItem(current, deps); // plan
    current = await advanceItem(current, deps); // launch
    await advanceItem(current, deps); // gate

    expect(gateInput?.merge).toBe(false);
  });

  it('parks an item whose repo does not route, without touching the launcher', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ZZZ-1', 1000);
    let provisionCalls = 0;
    const { deps } = buildDeps(store, {
      planner: { planTicket: async (ticket) => ({ ticket, repo: 'unknown', briefPath: `C:/briefs/${ticket}.md` }) },
      launcher: { provision: async (input) => { provisionCalls += 1; return { worktreePath: 'x', branch: 'y', base: 'z' }; } },
    });

    const result = await advanceItem(item, deps);
    expect(result.state).toBe('parked');
    expect(result.reason).toBe('unrouted');
    expect(provisionCalls).toBe(0);
  });

  it('parks an item whose council does not pass', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'FIX FIRST' }),
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    const result = await advanceItem(current, deps);
    expect(result.state).toBe('parked');
    expect(result.reason).toBe('FIX FIRST');
  });

  it('GATE.md item 4: a council parked on missing coverage carries that in the reason, not just the bare verdict', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({
        verdict: 'FIX FIRST', coverageNote: 'reviewed by 1 of 3 (missing: regression-risk, scope-conformance)',
      }),
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    const result = await advanceItem(current, deps);
    expect(result.state).toBe('parked');
    expect(result.reason).toContain('FIX FIRST');
    expect(result.reason).toContain('reviewed by 1 of 3');
    expect(result.reason).toContain('regression-risk');
  });

  it('parks an item whose run finished but no verdict was done', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'blocked' }) },
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    const result = await advanceItem(current, deps);
    expect(result.state).toBe('parked');
    expect(result.reason).toBe('blocked');
  });

  it('fails an item whose provisioning throws', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { provision: async () => { throw new Error('git worktree add failed'); } },
    });

    const planned = await advanceItem(item, deps);
    const result = await advanceItem(planned, deps);
    expect(result.state).toBe('failed');
    expect(result.reason).toContain('git worktree add failed');
  });

  it('resumes planning for an item already stuck in planning after a crash', async () => {
    const store = tempStore();
    store.append({
      id: 'q2', at: 1000, source: 'ticket', input: 'ABC-2', ticket: 'ABC-2', repo: null, briefPath: null,
      state: 'planning', reason: null, runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    const stuck = store.get('q2')!;
    const { deps } = buildDeps(store);
    const result = await advanceItem(stuck, deps);
    expect(result.state).toBe('running');
    expect(result.briefPath).toBe('C:/briefs/ABC-2.md');
  });
});

describe('runQueueTick', () => {
  it('refuses to start anything while the kill switch is engaged', async () => {
    const store = tempStore();
    addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, { killSwitch: () => true });
    const result = await runQueueTick(deps, store.all());
    expect(result).toEqual({ started: 0, advanced: 0, killSwitchEngaged: true, paused: false });
  });

  it('refuses to start anything while the queue is paused', async () => {
    const store = tempStore();
    addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, { paused: () => true });
    const result = await runQueueTick(deps, store.all());
    expect(result).toEqual({ started: 0, advanced: 0, killSwitchEngaged: false, paused: true });
  });

  it('keeps at most maxInFlight items moving, leaving the rest queued', async () => {
    const store = tempStore();
    addTicketItem(store, 'A-1', 1000);
    addTicketItem(store, 'A-2', 1000);
    addTicketItem(store, 'A-3', 1000);
    const { deps } = buildDeps(store, { maxInFlight: 2 });

    const result = await runQueueTick(deps, store.all());
    expect(result.started).toBe(2);
    const states = store.all().map((item) => item.state);
    expect(states.filter((s) => s === 'running').length).toBe(2);
    expect(states.filter((s) => s === 'queued').length).toBe(1);
  });

  it('advances already in-flight items before starting anything new', async () => {
    const store = tempStore();
    store.append({
      id: 'q1', at: 1000, source: 'ticket', input: 'A-1', ticket: 'A-1', repo: 'owner/name',
      briefPath: 'C:/briefs/a-1.md', branch: 'feature/a-1', worktreePath: 'C:/worktrees/repo--a-1', base: 'develop',
      state: 'running', runKey: 'a-1', reason: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    addTicketItem(store, 'A-2', 1000);
    const { deps } = buildDeps(store, {
      maxInFlight: 1,
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
    });

    const result = await runQueueTick(deps, store.all());
    expect(result.started).toBe(0);
    expect(store.get('q1')?.state).toBe('review');
  });

  // A council and gate pass takes minutes while the tick fires every ten seconds, so an
  // item whose advance is still awaiting is still `running` when the next tick reads the
  // queue. Without a lock the tick calls `advanceItem` for it again, and a live run of
  // this queue really did spawn three concurrent Codex processes for one item that way.
  it('never advances an item whose previous advance has not returned', async () => {
    const store = tempStore();
    addTicketItem(store, 'ABC-1', 1000);
    let calls = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { deps } = buildDeps(store, {
      planner: {
        planTicket: async (ticket) => {
          calls += 1;
          await held;
          return { ticket, repo: 'owner/name', briefPath: `C:/briefs/${ticket}.md` };
        },
      },
    });

    const first = runQueueTick(deps, store.all());
    await Promise.resolve();
    const second = runQueueTick(deps, store.all());
    release?.();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });
});
describe('a branch must sit on the latest base before anyone reviews it', () => {
  // Aaron, 2026-09-07. A queue that runs for hours branches off a base that keeps moving,
  // and BBZ-99 proved the cost: nothing fetched, so the review read five of other people's
  // merged commits as part of one ticket's diff, and the round's loudest finding belonged
  // to none of them.
  it('replays the branch on its base before the council reads it', async () => {
    const store = tempStore();
    store.append({
      id: 'q-abc-1', at: 1000, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: 'owner/name',
      briefPath: 'C:/briefs/abc-1.md', branch: 'feature/abc-1', worktreePath: 'C:/worktrees/repo--abc-1',
      base: 'develop', state: 'running', runKey: 'abc-1', reason: null, pr: null, journalIds: [],
      createdAt: 1000, updatedAt: 1000,
    });
    const order: string[] = [];
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }) },
      rebaseOnBase: async () => { order.push('rebase'); return { ok: true, behind: 3 }; },
      council: async () => { order.push('council'); return { verdict: 'PASS' as const }; },
    });

    await runQueueTick(deps, store.all());

    expect(order).toEqual(['rebase', 'council']);
    expect(store.all()[0]?.state).toBe('review');
  });

  it('parks the item when the branch cannot be replayed, rather than reviewing a conflict', async () => {
    const store = tempStore();
    store.append({
      id: 'q-abc-2', at: 1000, source: 'ticket', input: 'ABC-2', ticket: 'ABC-2', repo: 'owner/name',
      briefPath: 'C:/briefs/abc-2.md', branch: 'feature/abc-2', worktreePath: 'C:/worktrees/repo--abc-2',
      base: 'develop', state: 'running', runKey: 'abc-2', reason: null, pr: null, journalIds: [],
      createdAt: 1000, updatedAt: 1000,
    });
    let councilCalls = 0;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }) },
      rebaseOnBase: async () => ({ ok: false, behind: 7, reason: 'CONFLICT in src/app.tsx' }),
      council: async () => { councilCalls += 1; return { verdict: 'PASS' as const }; },
    });

    await runQueueTick(deps, store.all());

    const parked = store.all()[0];
    expect(parked?.state).toBe('parked');
    expect(parked?.reason).toContain('conflicts with develop');
    expect(councilCalls).toBe(0);
  });
});

