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
