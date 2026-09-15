/**
 * `computeLive`/`lastEventAtFor` (`src/forge/console/live.ts`): the board's fresh
 * "is the worker actually there" check, kept separate from `state` (a journal fold the
 * warden owns) on purpose -- a lane reading `running` with a dead pid must say
 * `alive: false` without anyone touching its `state`.
 */
import { describe, expect, it } from 'vitest';

import { RECENT_EVENT_MS, baseRunKey, computeLive, handoffSiblingKeys, lastEventAtFor } from '../../../src/forge/console/live.js';
import type { FleetState, RunState } from '../../../src/forge/journal.js';
import type { RegistryRecord } from '../../../src/forge/registry.js';

function runState(overrides: Partial<RunState> & Pick<RunState, 'run'>): RunState {
  return {
    state: 'started', turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0,
    cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0,
    ...overrides,
  };
}

function fleetWith(runs: Record<string, RunState>): FleetState {
  // Each run state's lastEventAt is mirrored as one worker row, since liveness reads rows.
  const events = Object.values(runs).filter((r) => r.lastEventAt > 0).map((r) => ev(r.run, 'worker', r.lastEventAt));
  return { events, runs, burn: {}, handoffs: 0, torn: 0, unknownModels: [], sessions: {} };
}

describe('baseRunKey', () => {
  it('strips a trailing handoff-attempt suffix when the ticket survives', () => {
    expect(baseRunKey('queue-BBZ-182-2')).toBe('queue-BBZ-182');
  });

  it('refuses to strip a ticket\'s own trailing number', () => {
    expect(baseRunKey('queue-BBZ-96')).toBe('queue-BBZ-96');
  });

  it('passes through a run with no extractable ticket unchanged', () => {
    expect(baseRunKey('S-abcdef1234567890')).toBe('S-abcdef1234567890');
  });
});

describe('handoffSiblingKeys', () => {
  it('finds the base and every numbered sibling, never an unrelated ticket', () => {
    const known = ['queue-BBZ-182', 'queue-BBZ-182-2', 'queue-BBZ-182-3', 'queue-BBZ-97'];
    expect(new Set(handoffSiblingKeys('queue-BBZ-182-2', known))).toEqual(
      new Set(['queue-BBZ-182', 'queue-BBZ-182-2', 'queue-BBZ-182-3']),
    );
  });
});

function ev(run: string, actor: string, at: number, event = 'tool.end'): FleetState['events'][number] {
  return { id: `${run}-${at}`, seq: at, at, event, actor, run, version: 1 } as FleetState['events'][number];
}

describe('lastEventAtFor', () => {
  it('is the newest worker or runner event across the base run and its -2 suffix', () => {
    const base = 'jira_BBZ-226_1788543015139';
    const runs = { [base]: runState({ run: base }), [`${base}-2`]: runState({ run: `${base}-2` }) };
    const events = [ev(base, 'worker', 1_000), ev(`${base}-2`, 'worker', 5_000), ev('queue-BBZ-9', 'worker', 9_000)];
    expect(lastEventAtFor(base, { events, runs })).toBe(5_000);
    expect(lastEventAtFor(`${base}-2`, { events, runs })).toBe(5_000);
  });

  it('ignores bookkeeping rows from the warden, governor and console, which fire for finished runs on every restart', () => {
    const runs = { alpha: runState({ run: 'alpha' }) };
    const events = [ev('alpha', 'worker', 1_000), ev('alpha', 'warden', 8_000, 'liveness.cleared'), ev('alpha', 'governor', 9_000, 'burn.mismatch'), ev('alpha', 'console', 9_500, 'note')];
    expect(lastEventAtFor('alpha', { events, runs })).toBe(1_000);
  });

  it('is null when no worker row exists for any sibling', () => {
    expect(lastEventAtFor('never-seen', { events: [], runs: {} })).toBeNull();
  });
});

describe('computeLive', () => {
  const registryRow: RegistryRecord = { goal: 'alpha', cwd: '.', briefPath: 'b.md', pid: 4242, startedAt: 0 };

  it('reads alive true with the pid when the registry has a row and the process answers', () => {
    const fleet = fleetWith({ alpha: runState({ run: 'alpha', lastEventAt: 9_000 }) });
    const live = computeLive('alpha', { fleet, registryGet: () => registryRow, isAlive: () => true }, 10_000);
    expect(live).toEqual({ alive: true, pid: 4242, lastEventAt: 9_000, checkedAt: 10_000 });
  });

  it('reads alive false once the process is gone and the journal has been quiet -- state is untouched by this module entirely', () => {
    const fleet = fleetWith({ alpha: runState({ run: 'alpha', lastEventAt: 9_000 }) });
    const live = computeLive('alpha', { fleet, registryGet: () => registryRow, isAlive: () => false }, 9_000 + RECENT_EVENT_MS + 1);
    expect(live.alive).toBe(false);
    expect(live.pid).toBe(4242);
  });

  it('reads alive true on a fresh journal event even when the registry pid is dead, the shape of a run the console resumed', () => {
    const fleet = fleetWith({ alpha: runState({ run: 'alpha', lastEventAt: 9_000 }) });
    const live = computeLive('alpha', { fleet, registryGet: () => registryRow, isAlive: () => false }, 14_000);
    expect(live.alive).toBe(true);
    expect(live.pid).toBe(4242);
  });

  it('reads alive false with a null pid when the registry has no row for this run', () => {
    const fleet = fleetWith({});
    const live = computeLive('gone', { fleet, registryGet: () => undefined, isAlive: () => true }, 10_000);
    expect(live).toEqual({ alive: false, pid: null, lastEventAt: null, checkedAt: 10_000 });
  });
});

// 2026-09-14, 14:24: runs killed from the console read `killed` per run while their queue
// items read `running` for minutes. A worker row written seconds before the kill kept the
// fold calling the run live for the whole recent-event window. Real process, real kill.
import { spawn as spawnKillableWorker } from 'node:child_process';
import { once as onceKilled } from 'node:events';
import { mkdtempSync as mkdtempForKill } from 'node:fs';
import { tmpdir as tmpdirForKill } from 'node:os';
import { join as joinForKill } from 'node:path';
import { deriveQueueItem, readQueueRun } from '../../../src/forge/console/live.js';
import { processAlive, Registry } from '../../../src/forge/registry.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

describe('a killed run stops reading live on the next read, not on a timer', () => {
  it('reads not alive, and its queue item not running, as soon as the killed process has exited', async () => {
    const registry = new Registry(mkdtempForKill(joinForKill(tmpdirForKill(), 'live-kill-')));
    const worker = spawnKillableWorker(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const run = 'queue-BBZ-140-Q-7a01a197';
      registry.admit({ goal: run, cwd: 'C:/worktrees/repo--bbz-140', briefPath: 'C:/briefs/BBZ-140.md', pid: worker.pid! });
      const before = Date.now();
      const working = fleetWith({ [run]: runState({ run, lastEventAt: before - 5_000 }) });
      const deps = { registryGet: (key: string) => registry.get(key), isAlive: processAlive };
      expect(computeLive(run, { ...deps, fleet: working }, before).alive).toBe(true);

      worker.kill();
      await onceKilled(worker, 'exit');
      const killed = fleetWith({ [run]: runState({ run, state: 'killed', lastEventAt: before - 5_000 }) });
      const after = Date.now();
      expect(after - before).toBeLessThan(RECENT_EVENT_MS);
      expect(computeLive(run, { ...deps, fleet: killed }, after).alive).toBe(false);

      const item = { id: 'Q-7a01a197', state: 'running', runKey: run, reason: null } as unknown as QueueItem;
      const read = deriveQueueItem(item, readQueueRun(run, { ...deps, fleet: killed }, after));
      expect(read.state).not.toBe('running');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    }
  });
});

// Review finding, 2026-09-14: a paused run waits on a resume, and a handed-off run's
// successor may not be folded yet. Neither is an orphan, so neither item may read parked
// (a parked card offers Retry, and a retry clears the run key and launches on the worktree).
describe('a running item whose run is paused or handed off is not an orphan', () => {
  it.each(['paused', 'handed-off'] as const)('stays running when its run is %s with no live process', (runState) => {
    const item = { id: 'Q-5c0ffee1', state: 'running', runKey: 'queue-BBZ-9-Q-5c0ffee1', reason: null } as unknown as QueueItem;
    const read = deriveQueueItem(item, { alive: false, pid: 4242, lastEventAt: null, checkedAt: 1, runState });
    expect(read.state).toBe('running');
  });
});

// Review finding, 2026-09-14: a run resumed after a restart keeps its old, dead registry pid,
// and the journal writes one row when a tool call starts and one when it ends. A worker inside
// a four-minute build is past the 90-second live window but is not an orphan. Only a long
// silence parks it; a kill parks it at once.
describe('a running item with a dead pid is an orphan only after a long silence', () => {
  const item = { id: 'Q-fdeab07a', state: 'running', runKey: 'queue-BBZ-77-Q-fdeab07a', reason: null } as unknown as QueueItem;
  const now = 50 * 60_000;
  it('stays running four minutes after its last work row', () => {
    const read = deriveQueueItem(item, { alive: false, pid: 4242, lastEventAt: now - 4 * 60_000, checkedAt: now, runState: 'started' });
    expect(read.state).toBe('running');
  });
  // Review finding, 2026-09-14: a run killed after its PR was up still goes to the gate
  // (`queue.ts`, `queue.unverified-pr`), and the item stays stored `running` while checks
  // are pending. That item is the gate's, not an orphan.
  it('stays running when killed while the gate holds its PR', () => {
    const killed = { alive: false, pid: 4242, lastEventAt: now - 10_000, checkedAt: now, runState: 'killed' as const };
    expect(deriveQueueItem({ ...item, pendingGatePolls: 2 } as QueueItem, killed).state).toBe('running');
    expect(deriveQueueItem({ ...item, pr: { number: 119, url: 'https://example.invalid/pr/119' } } as unknown as QueueItem, killed).state).toBe('running');
  });
  it('reads parked twenty minutes after its last work row, and at once when killed', () => {
    expect(deriveQueueItem(item, { alive: false, pid: 4242, lastEventAt: now - 20 * 60_000, checkedAt: now, runState: 'started' }).state).toBe('parked');
    expect(deriveQueueItem(item, { alive: false, pid: 4242, lastEventAt: now - 10_000, checkedAt: now, runState: 'killed' }).state).toBe('parked');
  });
});
