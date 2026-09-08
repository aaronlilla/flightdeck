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
  addBacklogItems, addBriefItem, addHotfixItem, addQueryItems, addTicketItem, advanceItem, mergeItem, promoteItem,
  QUEUE_IN_FLIGHT_STATES, removeItem, retryItem, runQueueTick,
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

  it('A.6: adds a queued item for a typed hotfix with no ticket yet', () => {
    const store = tempStore();
    const item = addHotfixItem(store, 'null check crashes the login screen', 1000);
    expect(item).toMatchObject({ source: 'hotfix', input: 'null check crashes the login screen', ticket: null, state: 'queued' });
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

describe('retry: a parked item whose run already finished launches again instead of re-parking', () => {
  // 2026-09-08 live specimen: BBZ-233's Q-0fff83b0 and Q-2181b071 parked again within
  // seconds of a retry click, because `deps.launcher.status(item.runKey)` still answered
  // `finished: true` for the same run that had already parked it, with no PR anywhere.
  it('clears runKey and relaunches when a retried item\'s run is finished with no PR', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let launchCalls = 0;
    const { deps, events } = buildDeps(store, {
      launcher: {
        launch: async ({ ticket }) => { launchCalls += 1; return { runKey: `${ticket.toLowerCase()}-${launchCalls}` }; },
        status: async () => ({ finished: true, verdict: 'parked' }),
      },
      gh: { findPrByHead: async () => undefined },
    });

    let current = item;
    current = await advanceItem(current, deps); // plan
    current = await advanceItem(current, deps); // launch
    const firstRunKey = current.runKey;
    current = await advanceItem(current, deps); // status finished, no PR -> park
    expect(current.state).toBe('parked');
    expect(current.runKey).toBe(firstRunKey);

    const retried = retryItem(store, current.id, 5000)!;
    expect(retried.state).toBe('running');
    expect(retried.runKey).toBe(firstRunKey);

    const relaunched = await advanceItem(retried, deps);
    expect(relaunched.state).not.toBe('parked');
    expect(relaunched.runKey).toBe('abc-1-2');
    expect(relaunched.runKey).not.toBe(firstRunKey);
    expect(launchCalls).toBe(2);
    expect(events.map((e) => e['event'])).toContain('queue.relaunch-on-retry');
  });

  it('an item retried while its finished run does carry a PR still goes to the gate, not a relaunch', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let launchCalls = 0;
    const { deps, events } = buildDeps(store, {
      launcher: {
        launch: async ({ ticket }) => { launchCalls += 1; return { runKey: `${ticket.toLowerCase()}-${launchCalls}` }; },
        status: async () => ({ finished: true, verdict: 'unverified' }),
      },
      gh: { findPrByHead: async () => ({ number: 119, url: 'https://example.invalid/pr/119' }) },
    });

    let current = item;
    current = await advanceItem(current, deps); // plan
    current = await advanceItem(current, deps); // launch

    // Simulate an operator's retry click landing while this run is still in flight, before
    // its status has finished with a PR -- the marker survives to the tick that reads it.
    store.append({ id: current.id, at: 4000, retriedAt: 4000 });
    const withRetry = store.get(current.id)!;

    const result = await advanceItem(withRetry, deps);
    expect(result.state).toBe('review');
    expect(launchCalls).toBe(1);
    expect(events.map((e) => e['event'])).not.toContain('queue.relaunch-on-retry');
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
      gh: { findPrByHead: async () => undefined },
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    const result = await advanceItem(current, deps);
    expect(result.state).toBe('parked');
    expect(result.reason).toBe('blocked');
  });

  it('takes an unverified run on to the gate when its branch already carries a PR', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const events: string[] = [];
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'unverified' }) },
      gh: { findPrByHead: async () => ({ number: 119, url: 'https://example.invalid/pr/119' }) },
    });
    const base = deps.append;
    deps.append = (event) => { events.push(String(event['event'])); return base(event); };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    const result = await advanceItem(current, deps);
    expect(events).toContain('queue.unverified-pr');
    expect(result.state).not.toBe('parked');
    expect(result.pr?.no).toBe(119);
  });

  it('still parks an unverified run that opened no PR', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'unverified' }) },
      gh: { findPrByHead: async () => undefined },
    });
    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    const result = await advanceItem(current, deps);
    expect(result.state).toBe('parked');
    expect(result.reason).toBe('unverified');
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

  // A.5: `advanceItem` had never been exercised end to end for a brief, a query or a
  // backlog sourced item before this stream -- only `ticket` items ever reached it in a
  // specimen, even though the same planning branch (`item.source === 'brief' ? planBrief
  // : planTicket`) already handled all four.
  it('walks a pasted brief through planBrief, never planTicket, to review', async () => {
    const store = tempStore();
    const item = addBriefItem(store, '# Goal: fix the null check', 1000);
    let planTicketCalls = 0;
    const { deps } = buildDeps(store, {
      planner: {
        planTicket: async (ticket) => { planTicketCalls += 1; return { ticket, repo: 'owner/name', briefPath: 'x' }; },
      },
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/3' }) },
    });

    let current = item;
    current = await advanceItem(current, deps);
    expect(current.ticket).toBe('BRIEF-1');
    expect(current.briefPath).toBe('C:/briefs/brief-1.md');
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(planTicketCalls).toBe(0);
  });

  it('walks a query-resolved ticket through planTicket, the same as a ticket-sourced item, to review', async () => {
    const store = tempStore();
    const search: QueueTicketSearch = { searchKeys: async () => ['ABC-1'] };
    const [item] = await addQueryItems(store, 'sprint = 42', search, 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/4' }) },
    });

    let current = item!;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(current.source).toBe('query');
    expect(current.ticket).toBe('ABC-1');
  });

  it('13:35 BBZ-233 specimen: advanceItem passes the queue item\'s own id into planTicket, not just the ticket', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-233', 1000);
    const seenItemIds: (string | undefined)[] = [];
    const { deps } = buildDeps(store, {
      planner: {
        planTicket: async (ticket, itemId) => {
          seenItemIds.push(itemId);
          return { ticket, repo: 'owner/name', briefPath: `C:/briefs/${ticket}-${itemId}.md` };
        },
      },
    });

    await advanceItem(item, deps);

    expect(seenItemIds).toEqual([item.id]);
  });

  it('walks a backlog-resolved ticket to review the same way', async () => {
    const store = tempStore();
    const search: QueueTicketSearch = { searchKeys: async () => ['ABC-9'] };
    const [item] = await addBacklogItems(store, 'project = BB AND text ~ "flaky"', search, 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/5' }) },
    });

    let current = item!;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(current.source).toBe('backlog');
    expect(current.ticket).toBe('ABC-9');
  });

  it('A.6: a hotfix routes through planHotfix, never planTicket or planBrief', async () => {
    const store = tempStore();
    const item = addHotfixItem(store, 'null check crashes the login screen', 1000);
    let planBriefCalls = 0;
    let planTicketCalls = 0;
    let planHotfixInput: string | undefined;
    const { deps } = buildDeps(store, {
      planner: {
        planBrief: async (text) => { planBriefCalls += 1; return { ticket: 'x', repo: 'owner/name', briefPath: 'x' }; },
        planTicket: async (ticket) => { planTicketCalls += 1; return { ticket, repo: 'owner/name', briefPath: 'x' }; },
      },
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/6' }) },
    });
    deps.planner.planHotfix = async (text) => {
      planHotfixInput = text;
      return { ticket: 'hotfix-null-check-1', repo: 'owner/name', briefPath: 'C:/briefs/hotfix-null-check-1.md' };
    };

    let current = item;
    current = await advanceItem(current, deps);
    expect(current.ticket).toBe('hotfix-null-check-1');
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(planBriefCalls).toBe(0);
    expect(planTicketCalls).toBe(0);
    expect(planHotfixInput).toBe('null check crashes the login screen');
  });

  it('A.6: a hotfix falls back to planBrief when planHotfix is not wired', async () => {
    const store = tempStore();
    const item = addHotfixItem(store, 'null check crashes the login screen', 1000);
    let planBriefInput: string | undefined;
    const { deps } = buildDeps(store, {
      planner: { planBrief: async (text) => { planBriefInput = text; return { ticket: 'x', repo: 'owner/name', briefPath: 'x' }; } },
    });

    const result = await advanceItem(item, deps);
    expect(result.ticket).toBe('x');
    expect(planBriefInput).toBe('null check crashes the login screen');
  });
});

describe('fix round: FIX FIRST relaunches once, a second parks', () => {
  it('relaunches the worker on the first FIX FIRST, carrying the findings as its brief', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let relaunchInput: { item: { id: string }; findings: string } | undefined;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'FIX FIRST', findingsText: '[high/high] src/x.ts:1 -- bad thing' }),
    });
    deps.relaunchForFixRound = async (input) => { relaunchInput = input; return { runKey: 'abc-1-fix-1' }; };

    let current = item;
    current = await advanceItem(current, deps); // plan
    current = await advanceItem(current, deps); // launch
    const result = await advanceItem(current, deps); // gate -> fix round

    expect(result.state).toBe('running');
    expect(result.fixRoundsUsed).toBe(1);
    expect(result.runKey).toBe('abc-1-fix-1');
    expect(relaunchInput?.findings).toContain('bad thing');
    expect(relaunchInput?.item.id).toBe(item.id);
  });

  it('parks on a second consecutive FIX FIRST rather than relaunching a second time', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'FIX FIRST' }),
    });
    let relaunchCalls = 0;
    deps.relaunchForFixRound = async () => { relaunchCalls += 1; return { runKey: `fix-${relaunchCalls}` }; };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps); // first FIX FIRST -> fix round
    current = await advanceItem(current, deps); // second FIX FIRST -> park

    expect(current.state).toBe('parked');
    expect(current.fixRoundsUsed).toBe(1);
    expect(relaunchCalls).toBe(1);
    expect(current.reason).toContain('FIX FIRST');
  });

  it('coverage-missing always parks, never spawns a fix round', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let relaunchCalls = 0;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'FIX FIRST', coverageNote: 'reviewed by 1 of 3 (missing: regression-risk)' }),
    });
    deps.relaunchForFixRound = async () => { relaunchCalls += 1; return { runKey: 'x' }; };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('parked');
    expect(relaunchCalls).toBe(0);
    expect(current.reason).toContain('reviewed by 1 of 3');
  });

  it('a FIX FIRST with no relaunchForFixRound dep wired still parks (no environment ever hard-fails)', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'FIX FIRST' }),
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('parked');
  });
});

describe('review comment: A.2', () => {
  it('posts the council notes on the PR before the item reaches review', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let commented: { repo: string; pr: number; body: string } | undefined;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS WITH NOTES', findingsText: '[low/medium] src/x.ts:2 -- a small nit' }),
    });
    deps.commentOnPr = async (input) => { commented = input; };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(commented?.repo).toBe('owner/name');
    expect(commented?.pr).toBe(1);
    expect(commented?.body).toContain('PASS WITH NOTES');
    expect(commented?.body).toContain('a small nit');
  });

  it('a failing comment call never keeps a cleared item off review', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.commentOnPr = async () => { throw new Error('gh: rate limited'); };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
  });
});

describe('backend path: A.4', () => {
  it('assigns the backend owner after the ticket write-up, so the owner stays the assignee', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBMS-1', 1000);
    const order: string[] = [];
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.repoKindFor = () => 'backend';
    deps.jiraHandoff = async () => { order.push('qa-assign'); };
    deps.backendHandoff = async () => { order.push('owner-assign'); };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(order).toEqual(['qa-assign', 'owner-assign']);
  });

  it('pings the backend owner in Jira and requests them as a reviewer for a backend item', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBMS-1', 1000);
    let handoffInput: { item: { ticket: string | null }; pr: { no: number } } | undefined;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.repoKindFor = () => 'backend';
    deps.backendHandoff = async (input) => { handoffInput = input; };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(handoffInput?.item.ticket).toBe('BBMS-1');
    expect(handoffInput?.pr.no).toBe(1);
  });

  it('never pings the backend owner for a frontend item', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let calls = 0;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.repoKindFor = () => 'frontend';
    deps.backendHandoff = async () => { calls += 1; };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(calls).toBe(0);
  });

  it('a failing backend ping never keeps the item off review', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBMS-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.repoKindFor = () => 'backend';
    deps.backendHandoff = async () => { throw new Error('jira down'); };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
  });
});

describe('Jira write-back at review: A.3', () => {
  it('runs the handoff once, at the transition into review, and stamps handoffAt', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-226', 1000);
    let handoffCalls = 0;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.jiraHandoff = async () => { handoffCalls += 1; };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(handoffCalls).toBe(1);
    expect(current.handoffAt).toBeTypeOf('number');
  });

  it('a failing handoff never keeps the item off review, and leaves handoffAt unset', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-226', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.jiraHandoff = async () => { throw new Error('jira down'); };

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
    expect(current.handoffAt).toBeUndefined();
  });
});

describe('real PR figures: A.8', () => {
  it('carries the real files/add/del onto the review pr, not the honest-zero placeholder', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.prSnapshot = async () => ({ files: ['src/a.ts', 'src/b.ts'], add: 12, del: 3 });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.pr).toMatchObject({ files: 2, add: 12, del: 3 });
  });

  // H1.3 fix: a fabricated 0 read as a real diff (the live board's own "0 files +0 -0"
  // on a PR nobody had actually read) -- with no `prSnapshot` dep wired, the fields
  // are absent instead, so the board can tell "not read" apart from "empty diff".
  it('omits files/add/del entirely when no prSnapshot dep is wired, rather than a fabricated 0', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'PASS' }),
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.pr?.files).toBeUndefined();
    expect(current.pr?.add).toBeUndefined();
    expect(current.pr?.del).toBeUndefined();
  });
});

describe('pre-council overlap check: A.9', () => {
  it('parks the later item when its changed files overlap an item already reviewing in the same repo', async () => {
    const store = tempStore();
    // The earlier item is already in review, carrying its own changed files.
    store.append({
      id: 'q-early', at: 1000, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: 'owner/name',
      briefPath: 'C:/briefs/abc-1.md', branch: 'feature/abc-1', worktreePath: 'C:/worktrees/repo--abc-1',
      base: 'develop', state: 'review', runKey: 'abc-1', reason: null,
      pr: { no: 1, url: 'https://github.com/owner/name/pull/1', files: 1, add: 1, del: 0, draft: true },
      changedFiles: ['src/shared.ts'], journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    const item = addTicketItem(store, 'ABC-2', 2000);
    let councilCalls = 0;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/2' }) },
      council: async () => { councilCalls += 1; return { verdict: 'PASS' as const }; },
    });
    deps.prSnapshot = async () => ({ files: ['src/shared.ts', 'src/other.ts'], add: 5, del: 1 });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('parked');
    expect(current.reason).toContain('src/shared.ts');
    expect(councilCalls).toBe(0);
  });

  it('never parks two items in the same repo that touch disjoint files', async () => {
    const store = tempStore();
    store.append({
      id: 'q-early', at: 1000, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: 'owner/name',
      briefPath: 'C:/briefs/abc-1.md', branch: 'feature/abc-1', worktreePath: 'C:/worktrees/repo--abc-1',
      base: 'develop', state: 'review', runKey: 'abc-1', reason: null,
      pr: { no: 1, url: 'https://github.com/owner/name/pull/1', files: 1, add: 1, del: 0, draft: true },
      changedFiles: ['src/shared.ts'], journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    const item = addTicketItem(store, 'ABC-2', 2000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/2' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.prSnapshot = async () => ({ files: ['src/unrelated.ts'], add: 2, del: 0 });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
  });

  it('never parks two items in different repos, even on the same file path', async () => {
    const store = tempStore();
    store.append({
      id: 'q-early', at: 1000, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: 'owner/other',
      briefPath: 'C:/briefs/abc-1.md', branch: 'feature/abc-1', worktreePath: 'C:/worktrees/other--abc-1',
      base: 'develop', state: 'review', runKey: 'abc-1', reason: null,
      pr: { no: 1, url: 'https://github.com/owner/other/pull/1', files: 1, add: 1, del: 0, draft: true },
      changedFiles: ['src/shared.ts'], journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    const item = addTicketItem(store, 'ABC-2', 2000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/2' }) },
      council: async () => ({ verdict: 'PASS' }),
    });
    deps.prSnapshot = async () => ({ files: ['src/shared.ts'], add: 2, del: 0 });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);

    expect(current.state).toBe('review');
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


describe('mergeItem: A.7', () => {
  function reviewItem(): ReturnType<typeof addTicketItem> {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    store.append({
      id: item.id, at: 2000, state: 'review', repo: 'owner/name', branch: 'feature/abc-1',
      pr: { no: 9, url: 'https://github.com/owner/name/pull/9', files: 1, add: 1, del: 0, draft: true },
    });
    return store.get(item.id)!;
  }

  it('refuses an item that is not in review', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const result = await mergeItem(item, {
      mergeAllowed: () => true, gate: async () => ({ merged: true }), clock: () => 3000, store,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a repo not on the queue\'s merge allow-list', async () => {
    const item = reviewItem();
    const result = await mergeItem(item, {
      mergeAllowed: () => false, gate: async () => ({ merged: true }), clock: () => 3000,
      store: { append: () => {} } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('allow-list');
  });

  it('calls gate with merge:true, sets done, and never touches unrelated fields', async () => {
    const item = reviewItem();
    let gateInput: { repo: string; pr: number; merge: boolean } | undefined;
    const result = await mergeItem(item, {
      mergeAllowed: () => true,
      gate: async (input) => { gateInput = input; return { merged: true }; },
      clock: () => 3000,
      store: { append: () => {} } as never,
    });
    expect(gateInput).toEqual({ repo: 'owner/name', pr: 9, merge: true });
    expect(result.ok).toBe(true);
    expect(result.item?.state).toBe('done');
  });

  it('sets done at once with the OTA pending, then writes the per-platform outcome when the deploy answers', async () => {
    const item = reviewItem();
    const rows: Array<Record<string, unknown>> = [];
    let settle: (v: { android: string; ios: string }) => void = () => {};
    const outcome = new Promise<{ android: string; ios: string }>((resolve) => { settle = resolve; });
    const result = await mergeItem(item, {
      mergeAllowed: () => true,
      gate: async () => ({ merged: true }),
      postMergeVerify: () => outcome,
      clock: () => 3000,
      store: { append: (row: Record<string, unknown>) => { rows.push(row); } } as never,
    });
    // The click returns before the deploy finishes: a develop deploy takes minutes and a
    // request must not wait on it.
    expect(result.item?.state).toBe('done');
    expect(result.item?.reason).toBe('merged; OTA pending');
    expect(rows).toHaveLength(1);
    settle({ android: 'update 10cbd28a', ios: 'update 12cd45b8' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows[1]).toMatchObject({ id: item.id, reason: 'OTA landed ios=update 12cd45b8 android=update 10cbd28a' });
  });

  it('records a deploy that never answered rather than leaving OTA pending forever', async () => {
    const item = reviewItem();
    const rows: Array<Record<string, unknown>> = [];
    await mergeItem(item, {
      mergeAllowed: () => true,
      gate: async () => ({ merged: true }),
      postMergeVerify: async () => undefined,
      clock: () => 3000,
      store: { append: (row: Record<string, unknown>) => { rows.push(row); } } as never,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows[1]).toMatchObject({ id: item.id, reason: 'merged; no develop deploy run was found for this merge' });
  });

  it('reports a merge that did not complete, without setting done', async () => {
    const item = reviewItem();
    const result = await mergeItem(item, {
      mergeAllowed: () => true, gate: async () => ({ merged: false }), clock: () => 3000,
      store: { append: () => {} } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.item).toBeUndefined();
  });

  it('carries the gate\'s own reason lines in the refusal message, not a "see the journal" pointer', async () => {
    const item = reviewItem();
    const result = await mergeItem(item, {
      mergeAllowed: () => true,
      gate: async () => ({ merged: false, reason: ['checks are red', 'council verdict is FIX FIRST'] }),
      clock: () => 3000,
      store: { append: () => {} } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('checks are red');
    expect(result.message).toContain('council verdict is FIX FIRST');
    expect(result.message).not.toContain('see the journal');
  });

  describe('B: a moved head with no attestation re-councils before refusing', () => {
    // 2026-09-08 13:41: PR #121 picked up a fix commit after its last council round, so
    // the gate refused with "no attestation for owner/name#9 at head <sha> -- run forge
    // council first" even though the fix was already good. Merge should re-council that
    // head itself rather than sending the operator back to run `forge council` by hand.
    it('re-councils once and retries the gate when the refusal names a missing attestation', async () => {
      const item = reviewItem();
      let gateCalls = 0;
      let councilInput: { repo: string; pr: number; cwd?: string; baseRef?: string } | undefined;
      const result = await mergeItem(item, {
        mergeAllowed: () => true,
        gate: async () => {
          gateCalls += 1;
          return gateCalls === 1
            ? { merged: false, reason: ['refused: no attestation for owner/name#9 at head abc123 -- run forge council first'] }
            : { merged: true };
        },
        council: async (input) => { councilInput = input; return { verdict: 'PASS' }; },
        clock: () => 3000,
        store: { append: () => {} } as never,
      });
      expect(gateCalls).toBe(2);
      expect(councilInput?.repo).toBe('owner/name');
      expect(councilInput?.pr).toBe(9);
      expect(result.ok).toBe(true);
      expect(result.item?.state).toBe('done');
    });

    it('calls no council when the gate\'s first attempt already carries an attestation', async () => {
      const item = reviewItem();
      let councilCalls = 0;
      const result = await mergeItem(item, {
        mergeAllowed: () => true,
        gate: async () => ({ merged: true }),
        council: async () => { councilCalls += 1; return { verdict: 'PASS' }; },
        clock: () => 3000,
        store: { append: () => {} } as never,
      });
      expect(councilCalls).toBe(0);
      expect(result.ok).toBe(true);
    });

    it('returns the original refusal, with the recouncil verdict in the message, on a FIX FIRST re-council', async () => {
      const item = reviewItem();
      let gateCalls = 0;
      const result = await mergeItem(item, {
        mergeAllowed: () => true,
        gate: async () => {
          gateCalls += 1;
          return { merged: false, reason: ['refused: no attestation for owner/name#9 at head abc123 -- run forge council first'] };
        },
        council: async () => ({ verdict: 'FIX FIRST', coverageNote: 'still red' }),
        clock: () => 3000,
        store: { append: () => {} } as never,
      });
      expect(gateCalls).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('no attestation for');
      expect(result.message).toContain('FIX FIRST');
      expect(result.message).toContain('still red');
    });

    it('journals queue.recouncil exactly once for the re-council', async () => {
      const item = reviewItem();
      const rows: Array<Record<string, unknown>> = [];
      let gateCalls = 0;
      await mergeItem(item, {
        mergeAllowed: () => true,
        gate: async () => {
          gateCalls += 1;
          return gateCalls === 1
            ? { merged: false, reason: ['refused: no attestation for owner/name#9 at head abc123 -- run forge council first'] }
            : { merged: true };
        },
        council: async () => ({ verdict: 'PASS' }),
        append: (event) => { rows.push(event); return { id: 'e1' }; },
        clock: () => 3000,
        store: { append: () => {} } as never,
      });
      expect(rows.filter((row) => row['event'] === 'queue.recouncil')).toHaveLength(1);
    });
  });
});

describe('promoteItem: A.7', () => {
  function doneHotfix(): ReturnType<typeof addHotfixItem> {
    const store = tempStore();
    const item = addHotfixItem(store, 'crash fix', 1000);
    store.append({ id: item.id, at: 2000, state: 'done', repo: 'owner/name', source: 'hotfix' });
    return store.get(item.id)!;
  }

  it('refuses anything but a hotfix item', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const result = await promoteItem(item, { version: '1.0.0', message: 'x' }, {
      productionWorkflowExists: async () => true,
    });
    expect(result).toMatchObject({ ok: false, code: 400 });
  });

  it('refuses a hotfix that has not shipped to dev yet', async () => {
    const store = tempStore();
    const item = addHotfixItem(store, 'crash fix', 1000);
    const result = await promoteItem(item, { version: '1.0.0', message: 'x' }, {
      productionWorkflowExists: async () => true,
    });
    expect(result).toMatchObject({ ok: false, code: 409 });
  });

  it('501s by name when the production workflow is not on develop', async () => {
    const item = doneHotfix();
    const result = await promoteItem(item, { version: '1.0.0', message: 'x' }, {
      productionWorkflowExists: async () => false,
    });
    expect(result).toMatchObject({ ok: false, code: 501 });
    expect(result.message).toContain('production publish workflow');
  });

  it('501s when the workflow exists but no dispatch is wired', async () => {
    const item = doneHotfix();
    const result = await promoteItem(item, { version: '1.0.0', message: 'x' }, {
      productionWorkflowExists: async () => true,
    });
    expect(result).toMatchObject({ ok: false, code: 501 });
    expect(result.message).toContain('no production publish wiring');
  });

  it('dispatches when the workflow exists and a promote dep is wired', async () => {
    const item = doneHotfix();
    let promoted: { item: { id: string }; version: string; message: string } | undefined;
    const result = await promoteItem(item, { version: '1.3.1', message: 'crash fix' }, {
      productionWorkflowExists: async () => true,
      promote: async (input) => { promoted = input; },
    });
    expect(result).toMatchObject({ ok: true, code: 200 });
    expect(promoted?.version).toBe('1.3.1');
  });
});

describe('a review item whose PR merged elsewhere', () => {
  it('lands on done on the next sweep, with the PR named in the reason', async () => {
    const { resetMergedSweep } = await import('../../../src/forge/intake/queue.js');
    resetMergedSweep();
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    store.append({ id: item.id, at: 2000, state: 'review', repo: 'owner/name', pr: { no: 118, url: 'u', files: 1, add: 1, del: 0, draft: true }, updatedAt: 2000 } as never);
    const { deps } = buildDeps(store, {});
    deps.prMerged = async (_repo, pr) => pr === 118;
    await runQueueTick(deps, store.all());
    expect(store.get(item.id)?.state).toBe('done');
    expect(store.get(item.id)?.reason).toBe('PR #118 merged outside the queue');
  });
});
