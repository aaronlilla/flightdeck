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
  addBacklogItems, addBriefItem, addGoalItem, addHotfixItem, addQueryItems, addTicketItem, advanceItem, mergeItem, promoteItem,
  PENDING_CHECKS_POLL_CAP, QUEUE_IN_FLIGHT_STATES, removeItem, retryItem, runQueueTick,
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
  maxInFlight?: () => number;
  launchGoal?: QueueRuntimeDeps['launchGoal'];
  mergeAllowed?: QueueRuntimeDeps['mergeAllowed'];
  postMergeVerify?: QueueRuntimeDeps['postMergeVerify'];
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
    maxInFlight: overrides.maxInFlight ?? (() => 2),
    append: (event) => {
      seq += 1;
      const id = `e${seq}`;
      events.push({ id, ...event });
      return { id };
    },
    store,
    ...(overrides.launchGoal ? { launchGoal: overrides.launchGoal } : {}),
    ...(overrides.mergeAllowed ? { mergeAllowed: overrides.mergeAllowed } : {}),
    ...(overrides.postMergeVerify ? { postMergeVerify: overrides.postMergeVerify } : {}),
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

  describe('addBriefItem: R-02 guard #1', () => {
    const ROADMAP = [
      '| id | delivers | serves | status | pr | proof |',
      '| --- | --- | --- | --- | --- | --- |',
      '| R-01 | thing one | queue | done | owner/repo#1 | link |',
      '| R-02 | thing two | queue | planned |  |  |',
    ].join('\n');

    it('refuses a self-repo brief with no roadmap line', () => {
      const store = tempStore();
      const brief = ['repo: aaronlilla/flightdeck', 'do the thing'].join('\n');
      expect(() => addBriefItem(store, brief, 1000, { selfRepo: 'aaronlilla/flightdeck', roadmapText: ROADMAP }))
        .toThrow(/missing a "roadmap: R-nn" line/);
    });

    it('refuses a self-repo brief naming an unknown or already-done roadmap id', () => {
      const store = tempStore();
      const doneBrief = ['repo: aaronlilla/flightdeck', 'roadmap: R-01', 'do the thing'].join('\n');
      expect(() => addBriefItem(store, doneBrief, 1000, { selfRepo: 'aaronlilla/flightdeck', roadmapText: ROADMAP }))
        .toThrow(/unknown or already-done roadmap id R-01/);

      const unknownBrief = ['repo: aaronlilla/flightdeck', 'roadmap: R-99', 'do the thing'].join('\n');
      expect(() => addBriefItem(store, unknownBrief, 1000, { selfRepo: 'aaronlilla/flightdeck', roadmapText: ROADMAP }))
        .toThrow(/unknown or already-done roadmap id R-99/);
    });

    it('accepts a self-repo brief naming an open roadmap id and records it on the item', () => {
      const store = tempStore();
      const brief = ['repo: aaronlilla/flightdeck', 'roadmap: R-02', 'do the thing'].join('\n');
      const item = addBriefItem(store, brief, 1000, { selfRepo: 'aaronlilla/flightdeck', roadmapText: ROADMAP });
      expect(item).toMatchObject({ source: 'brief', roadmap: 'R-02', state: 'queued' });
    });

    it('leaves a brief for a different repo unaffected even with no roadmap line', () => {
      const store = tempStore();
      const brief = ['repo: aaronlilla/other-repo', 'do the thing'].join('\n');
      const item = addBriefItem(store, brief, 1000, { selfRepo: 'aaronlilla/flightdeck', roadmapText: ROADMAP });
      expect(item).toMatchObject({ source: 'brief', state: 'queued' });
    });

    it('leaves a brief unaffected with no guard at all, same as the existing call form', () => {
      const store = tempStore();
      const brief = ['repo: aaronlilla/flightdeck', 'do the thing'].join('\n');
      const item = addBriefItem(store, brief, 1000);
      expect(item).toMatchObject({ source: 'brief', state: 'queued' });
    });
  });

  it('A.6: adds a queued item for a typed hotfix with no ticket yet', () => {
    const store = tempStore();
    const item = addHotfixItem(store, 'null check crashes the login screen', 1000);
    expect(item).toMatchObject({ source: 'hotfix', input: 'null check crashes the login screen', ticket: null, state: 'queued' });
  });

  it('2026-09-08: adds a queued goal item carrying its resolved /goal block and the goal path as briefPath', () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    expect(item).toMatchObject({
      source: 'goal', input: '/w/.claude/goals/2026-09-08-thing.md',
      briefPath: '/w/.claude/goals/2026-09-08-thing.md', goalBlock: '/goal Work the thing.',
      ticket: null, repo: null, state: 'queued',
    });
    expect(store.all()).toEqual([item]);
  });
});

describe('advanceItem: goal source', () => {
  it('skips the planner and provisioning, launching directly on the resolved block', async () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    let launchedWith: { goalPath: string; block: string; cwd: string } | undefined;
    const { deps } = buildDeps(store, {
      launchGoal: async (input) => { launchedWith = input; return { runKey: 'goal-run-1' }; },
    });

    const advanced = await advanceItem(item, deps);

    expect(advanced.state).toBe('running');
    expect(advanced.runKey).toBe('goal-run-1');
    expect(launchedWith?.block).toBe('/goal Work the thing.');
    expect(launchedWith?.goalPath).toBe('/w/.claude/goals/2026-09-08-thing.md');
  });

  it('fails outright with no launchGoal dependency wired', async () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    const { deps } = buildDeps(store);

    const advanced = await advanceItem(item, deps);

    expect(advanced.state).toBe('failed');
  });

  it('reaches done once the run finishes with verdict done, skipping review entirely', async () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    const { deps } = buildDeps(store, {
      launchGoal: async () => ({ runKey: 'goal-run-2' }),
      launcher: { status: async () => ({ finished: false }) },
    });

    const launched = await advanceItem(item, deps);
    const { deps: deps2 } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done' }) },
    });
    const finished = await advanceItem(launched, deps2);

    expect(finished.state).toBe('done');
    expect(finished.reason).toBe('goal loop ended');
  });

  it('2026-09-08: appends the run\'s last-turn text to the done reason when the status carries one', async () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    const { deps } = buildDeps(store, { launchGoal: async () => ({ runKey: 'goal-run-4' }) });
    const launched = await advanceItem(item, deps);

    const { deps: deps2 } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', lastText: 'Goal met: probe file written.' }) },
    });
    const finished = await advanceItem(launched, deps2);

    expect(finished.reason).toBe('goal loop ended: Goal met: probe file written.');
  });

  it('2026-09-08: passes launchGoal a run key unique to this item, never the bare goal-path basename', async () => {
    const store = tempStore();
    const itemA = addGoalItem(store, '/w/.claude/goals/same-file.md', '/goal Work the thing.', 1000);
    const itemB = addGoalItem(store, '/w/.claude/goals/same-file.md', '/goal Work the thing.', 1001);
    const runKeysSeen: string[] = [];
    const { deps } = buildDeps(store, {
      launchGoal: async (input) => { runKeysSeen.push(input.runKey); return { runKey: input.runKey }; },
    });

    await advanceItem(itemA, deps);
    await advanceItem(itemB, deps);

    expect(runKeysSeen).toHaveLength(2);
    expect(runKeysSeen[0]).not.toBe(runKeysSeen[1]);
    expect(runKeysSeen[0]).toContain(itemA.id);
    expect(runKeysSeen[1]).toContain(itemB.id);
  });

  // 2026-09-08 live incident: Q-17bb4283 hit the implement-class context ceiling and
  // handed off to a successor session the same way a brief-source item does. The
  // handoff itself never surfaces here: `deps.launcher.status` keeps answering
  // `finished: false` for as long as a successor is still running, mid-handoff, via
  // the same shared `runOutcome` reader both source types use (`chain-wire.ts`). So
  // reproducing "the goal item takes the successor path" means simulating what its
  // status reports once every successor is done: a terminal, non-`done` verdict such
  // as `exhausted`. That used to fail the item outright with the bare word `exhausted`
  // (or `parked`) as its reason. It now parks instead, exactly like a brief-source item
  // on the same verdict, and stays reachable by retry rather than getting abandoned.
  it('parks, not fails, when the run finishes with a non-done verdict after exhausting its handoff chain', async () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    const { deps } = buildDeps(store, { launchGoal: async () => ({ runKey: 'goal-run-3' }) });
    const launched = await advanceItem(item, deps);
    expect(launched.state).toBe('running');
    expect(launched.runKey).toBe('goal-run-3');

    const { deps: deps2, events } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'exhausted' }) },
    });
    const finished = await advanceItem(launched, deps2);

    expect(finished.state).toBe('parked');
    expect(finished.reason).toBe('exhausted');
    expect(finished.runKey).toBe('goal-run-3');
    expect(events.map((e) => e['event'])).toContain('queue.parked');
  });

  // Mid-handoff (a successor still running), there is no terminal state at all: the
  // shared `runOutcome` reader answers `finished: false` for exactly as long as a
  // successor is in flight. The item takes neither the `done` branch nor the park
  // branch. It comes back unchanged, still `running` on its original run key, and
  // gets picked up again on the next tick.
  it('stays running on its own run key while a handoff to a successor session is still in flight', async () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    const { deps } = buildDeps(store, { launchGoal: async () => ({ runKey: 'goal-run-5' }) });
    const launched = await advanceItem(item, deps);

    const { deps: deps2 } = buildDeps(store, { launcher: { status: async () => ({ finished: false }) } });
    const stillRunning = await advanceItem(launched, deps2);

    expect(stillRunning.state).toBe('running');
    expect(stillRunning.runKey).toBe('goal-run-5');
  });

  it('an operator retry relaunches a parked goal item on a fresh run key via launchGoal', async () => {
    const store = tempStore();
    const item = addGoalItem(store, '/w/.claude/goals/2026-09-08-thing.md', '/goal Work the thing.', 1000);
    let launchCalls = 0;
    const { deps } = buildDeps(store, {
      launchGoal: async (input) => { launchCalls += 1; return { runKey: `${input.runKey}-${launchCalls}` }; },
    });
    const launched = await advanceItem(item, deps);

    const { deps: deps2 } = buildDeps(store, {
      launchGoal: deps.launchGoal,
      launcher: { status: async () => ({ finished: true, verdict: 'exhausted' }) },
    });
    const parked = await advanceItem(launched, deps2);
    expect(parked.state).toBe('parked');

    const retried = retryItem(store, parked.id, 5000)!;
    expect(retried.state).toBe('running');
    expect(retried.runKey).toBe(parked.runKey);

    const relaunched = await advanceItem(retried, deps2);
    expect(relaunched.state).toBe('running');
    expect(relaunched.runKey).not.toBe(launched.runKey);
    expect(launchCalls).toBe(2);
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

  it('BBZ: an item whose repo is on the operator\'s autoMerge allow-list reaches done with the merge recorded', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let gateInput: { repo: string; pr: number; merge: boolean } | undefined;
    const { deps, events } = buildDeps(store, {
      launcher: {
        status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }),
      },
      gate: async (input) => { gateInput = input; return { merged: true, mergeSha: 'deadbeef' }; },
      mergeAllowed: (repo) => repo === 'owner/name',
    });

    let current = item;
    current = await advanceItem(current, deps); // plan
    current = await advanceItem(current, deps); // launch
    const result = await advanceItem(current, deps); // gate + merge

    expect(gateInput?.merge).toBe(true);
    expect(result.state).toBe('done');
    expect(result.mergedBy).toBe('queue');
    expect(result.mergedAt).toBeDefined();
    expect(events.map((e) => e['event'])).toContain('queue.done');
  });

  it('BBZ: a repo absent from the autoMerge allow-list still stops at review with a draft PR', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let gateInput: { repo: string; pr: number; merge: boolean } | undefined;
    const { deps } = buildDeps(store, {
      launcher: {
        status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }),
      },
      gate: async (input) => { gateInput = input; return { merged: false }; },
      // Configured, but for a different repo -- the allow-list itself is what gates this,
      // not merely whether `mergeAllowed` is wired at all.
      mergeAllowed: (repo) => repo === 'some/other-repo',
    });

    let current = item;
    current = await advanceItem(current, deps); // plan
    current = await advanceItem(current, deps); // launch
    const result = await advanceItem(current, deps); // gate

    expect(gateInput?.merge).toBe(false);
    expect(result.state).toBe('review');
    expect(result.pr).toMatchObject({ no: 9, draft: true });
    expect(result.mergedBy).toBeUndefined();
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

  // BBZ-60/62/74/202, 2026-09-08: four items reached the gate hop while their PR checks
  // were still queued and parked with the council's raw "checks are pending" refusal --
  // every one of them went green minutes later, but a parked item never retries and
  // `mergeItem` only answers "not in review", so the queue could not finish its own
  // work. A pending council result is "not yet", never "no": the item must stay in a
  // state the next tick retries, not park.
  it('a pending council result stays running and retries, rather than parking', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'unavailable', pending: true }),
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    const result = await advanceItem(current, deps);
    expect(result.state).toBe('running');
    expect(result.reason).toMatch(/checks are pending/);
    expect(result.pendingGatePolls).toBe(1);
  });

  it('a pending council result that later turns success carries the item on to review', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    let pending = true;
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => (pending ? { verdict: 'unavailable', pending: true } : { verdict: 'PASS' }),
    });

    let current = item;
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    current = await advanceItem(current, deps);
    expect(current.state).toBe('running');

    pending = false;
    const result = await advanceItem(current, deps);
    expect(result.state).toBe('review');
  });

  it('parks a pending council result once it has never settled after the poll cap', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => ({ verdict: 'unavailable', pending: true }),
    });

    let current = item;
    current = await advanceItem(current, deps); // plan
    current = await advanceItem(current, deps); // launch
    for (let i = 0; i < PENDING_CHECKS_POLL_CAP; i += 1) {
      current = await advanceItem(current, deps);
      if (current.state === 'parked') break;
    }
    expect(current.state).toBe('parked');
    expect(current.reason).toMatch(/never settled/);
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

  it('attaches to the live run instead of failing when launch refuses a duplicate worktree', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps, events } = buildDeps(store, {
      launcher: {
        launch: async () => {
          throw new Error(
            'worker process exited with code 1 before the run registered\n' +
            'refusing to start queue-brief-2: C:/worktrees/repo--abc-1 already has a live run (goal queue-brief-1, pid 62720)',
          );
        },
      },
    });

    const planned = await advanceItem(item, deps);
    const result = await advanceItem(planned, deps);
    expect(result.state).toBe('running');
    expect(result.runKey).toBe('queue-brief-1');
    expect(events.some((e) => e['event'] === 'queue.duplicate-launch' && e['liveRunKey'] === 'queue-brief-1')).toBe(true);
  });

  it('still fails an item whose launch throws for a reason that is not a live-run refusal', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    const { deps } = buildDeps(store, {
      launcher: { launch: async () => { throw new Error('git worktree add failed'); } },
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
    const { deps } = buildDeps(store, { maxInFlight: () => 2 });

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
      maxInFlight: () => 1,
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

  // Same race as the plan hop above, but at the launch hop specifically -- the hop that
  // orphaned a live run on 2026-09-08 (BBZ-140 / Q-7a01a197) because a second overlapping
  // tick called `deps.launcher.launch` again for an item already mid-launch.
  it('never launches an item a second time while its first launch has not returned', async () => {
    const store = tempStore();
    store.append({
      id: 'q1', at: 1000, source: 'ticket', input: 'A-1', ticket: 'A-1', repo: 'owner/name',
      briefPath: 'C:/briefs/a-1.md', branch: null, worktreePath: null, base: null,
      state: 'running', runKey: null, reason: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    let calls = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { deps } = buildDeps(store, {
      launcher: {
        launch: async ({ ticket }) => {
          calls += 1;
          await held;
          return { runKey: ticket.toLowerCase() };
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

  // 2026-09-08: Q-0fb06912 and Q-56440c7b both parked on "You have unstaged changes"
  // because a worker left a test-isolation edit uncommitted. The rebase itself now
  // commits those leftovers before replaying (chain-wire.ts) -- this proves the queue
  // side journals that and tells a reviewer, rather than the item silently sailing on
  // as if nothing happened.
  it('journals a leftover commit and notes it on the PR, without parking the item', async () => {
    const store = tempStore();
    store.append({
      id: 'q-abc-3', at: 1000, source: 'ticket', input: 'ABC-3', ticket: 'ABC-3', repo: 'owner/name',
      briefPath: 'C:/briefs/abc-3.md', branch: 'feature/abc-3', worktreePath: 'C:/worktrees/repo--abc-3',
      base: 'develop', state: 'running', runKey: 'abc-3', reason: null, pr: null, journalIds: [],
      createdAt: 1000, updatedAt: 1000,
    });
    const { deps, events } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }) },
      rebaseOnBase: async () => ({ ok: true, behind: 2, committedLeftover: ['tests/setup.ts'] }),
      council: async () => ({ verdict: 'PASS' as const }),
    });
    const commented: { repo: string; pr: number; body: string }[] = [];
    deps.commentOnPr = async (input) => { commented.push(input); };

    await runQueueTick(deps, store.all());

    expect(store.all()[0]?.state).toBe('review');
    const leftoverEvent = events.find((e) => e['event'] === 'queue.leftover-committed');
    expect(leftoverEvent).toMatchObject({ itemId: 'q-abc-3', files: ['tests/setup.ts'] });
    const leftoverComment = commented.find((c) => c.body.includes('tests/setup.ts'));
    expect(leftoverComment?.repo).toBe('owner/name');
    expect(leftoverComment?.pr).toBe(9);
  });

  it('a failing PR comment about the leftover commit never parks the item', async () => {
    const store = tempStore();
    store.append({
      id: 'q-abc-4', at: 1000, source: 'ticket', input: 'ABC-4', ticket: 'ABC-4', repo: 'owner/name',
      briefPath: 'C:/briefs/abc-4.md', branch: 'feature/abc-4', worktreePath: 'C:/worktrees/repo--abc-4',
      base: 'develop', state: 'running', runKey: 'abc-4', reason: null, pr: null, journalIds: [],
      createdAt: 1000, updatedAt: 1000,
    });
    const { deps, events } = buildDeps(store, {
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }) },
      rebaseOnBase: async () => ({ ok: true, behind: 2, committedLeftover: ['tests/setup.ts'] }),
      council: async () => ({ verdict: 'PASS' as const }),
    });
    deps.commentOnPr = async () => { throw new Error('gh: rate limited'); };

    await runQueueTick(deps, store.all());

    expect(store.all()[0]?.state).toBe('review');
    expect(events.some((e) => e['event'] === 'queue.leftover-committed')).toBe(true);
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
    expect(rows[1]).toMatchObject({ id: item.id, reason: 'OTA published: android update 10cbd28a, ios update 12cd45b8' });
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
    expect(rows[1]).toMatchObject({ id: item.id, reason: 'merged; deploy run not found after 30 minutes' });
  });

  it('marks the item mergedBy: queue at once so the merged-elsewhere sweep never relabels it (BBZ-178)', async () => {
    const item = reviewItem();
    const rows: Array<Record<string, unknown>> = [];
    const result = await mergeItem(item, {
      mergeAllowed: () => true,
      gate: async () => ({ merged: true }),
      clock: () => 3000,
      store: { append: (row: Record<string, unknown>) => { rows.push(row); } } as never,
    });
    expect(result.item?.mergedBy).toBe('queue');
    expect(result.item?.mergedAt).toBe(3000);
    expect(rows[0]).toMatchObject({ id: item.id, mergedBy: 'queue', mergedAt: 3000 });
  });

  it('passes the gate\'s own mergeSha through to postMergeVerify', async () => {
    const item = reviewItem();
    let seenMergeSha: string | undefined;
    await mergeItem(item, {
      mergeAllowed: () => true,
      gate: async () => ({ merged: true, mergeSha: '7883356abcdef' }),
      postMergeVerify: async (input) => { seenMergeSha = input.mergeSha; return undefined; },
      clock: () => 3000,
      store: { append: () => {} } as never,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seenMergeSha).toBe('7883356abcdef');
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

  it('never relabels a merge the queue performed itself, even off a stale snapshot (BBZ-178)', async () => {
    const { resetMergedSweep } = await import('../../../src/forge/intake/queue.js');
    resetMergedSweep();
    const store = tempStore();
    const item = addTicketItem(store, 'ABC-1', 1000);
    store.append({ id: item.id, at: 2000, state: 'review', repo: 'owner/name', pr: { no: 122, url: 'u', files: 1, add: 1, del: 0, draft: true }, updatedAt: 2000 } as never);
    // The queue's own Merge click landed on the store (state: done, mergedBy: queue)
    // between the moment this tick's item snapshot was taken and the sweep running --
    // the snapshot below still shows 'review', as `runQueueTick`'s caller would.
    const staleSnapshot = store.all();
    store.append({ id: item.id, at: 2100, state: 'done', reason: 'merged; OTA pending', mergedBy: 'queue', mergedAt: 2100, updatedAt: 2100 } as never);
    const { deps } = buildDeps(store, {});
    deps.prMerged = async (_repo, pr) => pr === 122;
    await runQueueTick(deps, staleSnapshot);
    expect(store.get(item.id)?.state).toBe('done');
    expect(store.get(item.id)?.reason).toBe('merged; OTA pending');
  });
});
