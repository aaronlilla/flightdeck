/**
 * P4.7/I2: the `forge up` liveness cadence that actually calls the Warden's primitives.
 * Every stream that built one (fleet health, cost-shape, conformance drift, blocker
 * board) shipped a correct, tested unit that nothing in production invoked -- this is
 * that invocation, in the order the integration brief names, each guarded so one throw
 * never stops the rest.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedStuckSignal, Reasoner } from '../../src/forge/contracts.js';
import { BlockerBoard } from '../../src/forge/blockers.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { Registry, type RelaunchOutcome } from '../../src/forge/registry.js';
import { WardenActuator } from '../../src/forge/warden.js';
import { DriftCadenceTracker, WardenTick } from '../../src/forge/warden-tick.js';
import { readParkRecord } from '../../src/forge/parkrecord.js';

let dir: string;
let journalPath: string;
let journal: Journal;
let registry: Registry;
let actuator: WardenActuator;
let killed: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-warden-tick-'));
  journalPath = join(dir, 'fleet.jsonl');
  process.env['FORGE_HOME'] = dir;
  mkdirSync(join(dir, 'registry'), { recursive: true });
  journal = new Journal(journalPath);
  registry = new Registry(join(dir, 'registry'));
  killed = [];
  actuator = new WardenActuator({
    journal, journalPath, registry, killProcess: (pid) => { killed.push(pid); },
  });
  // Every run name these specimens park through the actuator needs a registry row now
  // that the actuator itself refuses an unregistered id (I11's defense-in-depth); the
  // tick's own `isRegisteredRun` gate is what each specimen actually exercises.
  for (const goal of ['r1', 'r2', 'good', 'bad', 'lane-only']) {
    registry.admit({ goal, cwd: `nowhere/${goal}`, briefPath: 'nowhere/brief.md', pid: 1 });
  }
});

function makeStuck(overrides: Partial<ExtendedStuckSignal> = {}): ExtendedStuckSignal {
  return {
    key: 'r1', signal: 'idle', threshold: 120_000, observed: 200_000, since: 0,
    hint: 'run r1 has produced no event for 200s', ...overrides,
  };
}

describe('WardenTick.run', () => {
  it('parks a stuck run exactly once across three ticks, never kills, and survives a throw in reportFleetHealth', async () => {
    let now = 1_000_000;
    const stuckSignals: ExtendedStuckSignal[] = [makeStuck()];
    const reportFleetHealthSpy = vi.fn(() => { throw new Error('probe exploded'); });

    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => now,
      stuck: () => stuckSignals,
      liveRuns: () => [],
      reportFleetHealth: reportFleetHealthSpy,
    });

    await tick.run();
    now += 30_000;
    await tick.run();
    now += 30_000;
    await tick.run();

    expect(reportFleetHealthSpy).toHaveBeenCalledTimes(3);
    expect(killed).toHaveLength(0);

    const record = readParkRecord('r1');
    expect(record).toBeTruthy();

    const state = replay(journalPath);
    const parkedRows = state.events.filter((event) => event.event === 'warden.parked' && event.run === 'r1');
    expect(parkedRows).toHaveLength(1);
    expect(parkedRows[0]!['evidence']).toMatchObject({ signal: 'idle' });
  });

  it('parks again once a cleared trip re-trips', async () => {
    let stuckSignals: ExtendedStuckSignal[] = [makeStuck()];
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => Date.now(),
      stuck: () => stuckSignals,
      liveRuns: () => [],
      reportFleetHealth: () => 0,
    });

    await tick.run();
    stuckSignals = [];
    await tick.run();
    stuckSignals = [makeStuck()];
    await tick.run();

    const state = replay(journalPath);
    const parkedRows = state.events.filter((event) => event.event === 'warden.parked' && event.run === 'r1');
    expect(parkedRows).toHaveLength(2);
  });

  it('reports a trip on an unregistered key as warden.health, never parks it, and writes no directory', async () => {
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => Date.now(),
      stuck: () => [makeStuck({
        key: 'pid:9999', signal: 'stale-session',
        hint: "fleet pid 9999's session file has not updated in 6 minutes",
      })],
      liveRuns: () => [],
      reportFleetHealth: () => 0,
      isRegisteredRun: () => false,
    });

    await tick.run();
    await tick.run();
    await tick.run();

    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'warden.parked')).toBe(false);
    // health-repeat (S-b9d39bae548707e0): a trip on an unregistered key never got added
    // to `parkedTrips`, so it never got the "parked once" treatment a registered run's
    // trip gets. Every tick re-logged `warden.health` for as long as the trip stayed
    // open, and in production the warden reported the same `stale-session` key 1073
    // times in one run. One open trip across three ticks should journal one health row,
    // matching the dedupe a registered run's trip already gets.
    const healthRows = state.events.filter((e) => e.event === 'warden.health' && e['key'] === 'pid:9999');
    expect(healthRows).toHaveLength(1);
    expect(readParkRecord('pid:9999')).toBeUndefined();
  });

  it("I11b: when the tick's own isRegisteredRun disagrees with the actuator's real answer, "
    + 'the actuator wins -- warden.health, never warden.parked, no directory', async () => {
    // The tick's own registration snapshot says "registered"; the real actuator (backed
    // by a registry with no row for this key) refuses underneath it. Reproduces the
    // 2026-09-04 22:28 incident: twenty `warden.parked` rows for `pid:NNNN` keys with no
    // run directory, because the tick journaled off its own stale check instead of the
    // actuator's actual outcome.
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => Date.now(),
      stuck: () => [makeStuck({
        key: 'pid:5555', signal: 'stale-session',
        hint: "fleet pid 5555's session file has not updated in 6 minutes",
      })],
      liveRuns: () => [],
      reportFleetHealth: () => 0,
      isRegisteredRun: () => true,
    });

    await tick.run();
    await tick.run();
    await tick.run();

    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'warden.parked' && e.run === 'pid:5555')).toBe(false);
    const healthRows = state.events.filter((e) => e.event === 'warden.health' && e['key'] === 'pid:5555');
    expect(healthRows).toHaveLength(1);
    expect(readParkRecord('pid:5555')).toBeUndefined();
  });

  it('health-repeat: a stale-session trip on an unregistered fleet pid that stays open for '
    + 'hundreds of ticks is journaled as warden.health once, not once per tick', async () => {
    // Self finding, 2026-09-05: the warden reported `stale-session` 1073 times for the
    // same handful of fleet pids over a few hours of `forge up` ticks, one row every
    // ~30s while the same session file sat stale. `parkedTrips` is what dedupes a
    // `warden.parked` row across ticks (parkGenericTrips adds the id there once the
    // actuator confirms the park); the `health()` branch -- taken for every `pid:N` key,
    // since a fleet pid never has a registry row or a lane -- never added the id to that
    // set, so the same open trip re-journaled a fresh `warden.health` row on every single
    // tick for as long as the session stayed stale.
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => Date.now(),
      stuck: () => [makeStuck({
        key: 'pid:51456', signal: 'stale-session',
        hint: "fleet pid 51456's session file has not updated in 6 minutes",
      })],
      liveRuns: () => [],
      reportFleetHealth: () => 0,
      isRegisteredRun: () => false,
    });

    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick.run();
    }

    const state = replay(journalPath);
    const healthRows = state.events.filter((e) => e.event === 'warden.health' && e['key'] === 'pid:51456');
    expect(healthRows).toHaveLength(1);
  });

  it('still parks a registered run whose key passes isRegisteredRun', async () => {
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => Date.now(),
      stuck: () => [makeStuck()],
      liveRuns: () => [],
      reportFleetHealth: () => 0,
      isRegisteredRun: (key) => key === 'r1',
    });

    await tick.run();
    expect(readParkRecord('r1')?.reason).toBe('run r1 has produced no event for 200s');
  });

  it('I13: never parks on a context trip -- the worker owns its own ceiling', async () => {
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => Date.now(),
      // The exact shape C2 run 4 hit: a context trip at the class ceiling, keyed on a
      // registered run. Even a fresh run genuinely at its own ceiling must never be
      // parked a second time by the tick -- the worker's own handoff already owns it.
      stuck: () => [makeStuck({
        key: 'r1', signal: 'context', threshold: 150_000, observed: 150_200,
        hint: 'run r1 is at 150200 tokens against its implement class ceiling of 150000',
      })],
      liveRuns: () => [],
      reportFleetHealth: () => 0,
    });

    await tick.run();

    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'warden.parked')).toBe(false);
    expect(state.events.some((e) => e.event === 'run.parked')).toBe(false);
    expect(readParkRecord('r1')).toBeUndefined();
  });

  it('never acts on a fleet-unknown trip -- reportFleetHealth is the only thing that ever sees it', async () => {
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => Date.now(),
      stuck: () => [makeStuck({ key: 'fleet', signal: 'fleet-unknown', hint: 'probe failed' })],
      liveRuns: () => [],
      reportFleetHealth: () => 0,
    });

    await tick.run();
    const state = replay(journalPath);
    expect(state.events.some((event) => event.event === 'warden.parked')).toBe(false);
  });

  it('parks a run whose cost shape trips, with the cost-shape hint, not a duplicate idle park', async () => {
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => 2_000_000,
      stuck: () => [],
      liveRuns: () => [{
        run: 'r2',
        recentToolCalls: [],
        costShape: { run: 'r2', context: 400_000, cacheReadTokens: 380_000, totalReadTokens: 400_000, turnsSinceWrite: 40 },
      }],
      reportFleetHealth: () => 0,
    });

    await tick.run();
    const state = replay(journalPath);
    const rows = state.events.filter((event) => event.event === 'warden.parked' && event.run === 'r2');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!['evidence'])).toContain('not a context');
  });

  it('a throw inside one run\'s cost-shape check does not stop the next run\'s check', async () => {
    const tick = new WardenTick({
      journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
      now: () => 2_000_000,
      stuck: () => [],
      liveRuns: () => [
        {
          run: 'bad', recentToolCalls: [],
          get costShape(): never { throw new Error('boom: cost-shape input unreadable'); },
        },
        { run: 'good', recentToolCalls: [], costShape: { run: 'good', context: 400_000, cacheReadTokens: 380_000, totalReadTokens: 400_000, turnsSinceWrite: 40 } },
      ],
      reportFleetHealth: () => 0,
    });

    await tick.run();
    const state = replay(journalPath);
    expect(state.events.some((event) => event.event === 'warden.parked' && event.run === 'good')).toBe(true);
  });

  describe('B.2: registry-abandoned relaunch', () => {
    it('relaunches once and journals run.relaunched, never warden.parked, on the first death', async () => {
      let calls = 0;
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => Date.now(),
        stuck: () => [makeStuck({
          key: 'r1', signal: 'registry-abandoned',
          hint: 'run r1 has a registry row from a process that is no longer alive',
        })],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        relaunchAbandoned: async (): Promise<RelaunchOutcome> => { calls += 1; return 'relaunched'; },
      });

      await tick.run();

      expect(calls).toBe(1);
      const state = replay(journalPath);
      expect(state.events.some((e) => e.event === 'run.relaunched' && e.run === 'r1')).toBe(true);
      expect(state.events.some((e) => e.event === 'warden.parked')).toBe(false);
    });

    it('parks on a second death under the same goal, without relaunching again', async () => {
      let calls = 0;
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => Date.now(),
        stuck: () => [makeStuck({
          key: 'r1', signal: 'registry-abandoned',
          hint: 'run r1 has a registry row from a process that is no longer alive',
        })],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        relaunchAbandoned: async (): Promise<RelaunchOutcome> => { calls += 1; return 'relaunched'; },
      });

      await tick.run(); // first death: relaunches
      await tick.run(); // the same trip is still open (relaunch is quiet on how it went)

      expect(calls).toBe(1);
      const state = replay(journalPath);
      expect(state.events.filter((e) => e.event === 'run.relaunched')).toHaveLength(1);
      const parkedRows = state.events.filter((e) => e.event === 'warden.parked' && e.run === 'r1');
      expect(parkedRows).toHaveLength(1);
    });

    it('with no relaunchAbandoned wired at all, parks on the very first sighting', async () => {
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => Date.now(),
        stuck: () => [makeStuck({
          key: 'r1', signal: 'registry-abandoned',
          hint: 'run r1 has a registry row from a process that is no longer alive',
        })],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
      });

      await tick.run();

      const state = replay(journalPath);
      expect(state.events.some((e) => e.event === 'run.relaunched')).toBe(false);
      expect(state.events.some((e) => e.event === 'warden.parked' && e.run === 'r1')).toBe(true);
    });

    it('a relaunch still in flight is not relaunched again on the next tick', async () => {
      let calls = 0;
      let resolveRelaunch: ((outcome: RelaunchOutcome) => void) | undefined;
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => Date.now(),
        stuck: () => [makeStuck({
          key: 'r1', signal: 'registry-abandoned',
          hint: 'run r1 has a registry row from a process that is no longer alive',
        })],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        relaunchAbandoned: async (): Promise<RelaunchOutcome> => {
          calls += 1;
          return new Promise((resolve) => { resolveRelaunch = resolve; });
        },
      });

      const first = tick.run();
      await tick.run(); // fires while the first relaunch's engine.run() is still pending

      expect(calls).toBe(1);
      const midState = replay(journalPath);
      expect(midState.events.some((e) => e.event === 'warden.parked')).toBe(false);

      resolveRelaunch?.('relaunched');
      await first;

      expect(calls).toBe(1);
      const finalState = replay(journalPath);
      expect(finalState.events.some((e) => e.event === 'warden.parked')).toBe(false);
      expect(finalState.events.filter((e) => e.event === 'run.relaunched')).toHaveLength(1);
    });

    it('a second death after one relaunch parks with an honest hint', async () => {
      const parkHints: string[] = [];
      const originalPark = actuator.park.bind(actuator);
      actuator.park = async (run: string, reason: string): Promise<boolean> => {
        parkHints.push(reason);
        return originalPark(run, reason);
      };
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => Date.now(),
        stuck: () => [makeStuck({
          key: 'r1', signal: 'registry-abandoned',
          hint: 'run r1 has a registry row from a process that is no longer alive; '
            + 'its dangling tool call is history, never a reason to refuse the next launch',
        })],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        relaunchAbandoned: async (): Promise<RelaunchOutcome> => 'relaunched',
      });

      await tick.run(); // first death: relaunches
      await tick.run(); // second death under the same goal: parks

      expect(parkHints).toHaveLength(1);
      expect(parkHints[0]).toContain('relaunched once');
      expect(parkHints[0]).not.toContain('never a reason to refuse');
    });

    it('a second death is judged by activity, not by the stale registry row', async () => {
      let now = 1_000_000;
      let relaunchedAt: number | undefined;
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => now,
        stuck: () => [makeStuck({
          key: 'r1', signal: 'registry-abandoned',
          since: relaunchedAt !== undefined ? relaunchedAt + 60_000 : 900_000,
          hint: 'run r1 has a registry row from a process that is no longer alive',
        })],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        relaunchAbandoned: async (): Promise<RelaunchOutcome> => {
          relaunchedAt = now;
          return 'relaunched';
        },
      });

      await tick.run(); // first death: relaunches, records relaunchedAt
      now += 30_000;
      // The relaunched run produced a fresh journal event after the relaunch -- the
      // registry row is still the stale one (per the doc comment on
      // relaunchAbandonedGoal), but the trip's own `since` now sits after relaunchedAt,
      // which is the live signal that this is the resumed run still working, not a
      // second death.
      await tick.run();

      const state = replay(journalPath);
      expect(state.events.some((e) => e.event === 'warden.parked')).toBe(false);
      expect(state.events.filter((e) => e.event === 'run.relaunched')).toHaveLength(1);
    });
  });

  describe('B.3: reap the provably dead', () => {
    it('reaps a dead, long-parked row and journals registry.reaped, signalling no process', async () => {
      let released: string | undefined;
      let laneMarked: string | undefined;
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => 5 * 60 * 60_000,
        stuck: () => [],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        registryRows: () => [{ goal: 'r1', cwd: 'nowhere/r1', briefPath: 'nowhere/brief.md', pid: 1, startedAt: 0 }],
        isAlive: () => false,
        parkedAt: () => 0,
        releaseRegistryRow: (goal) => { released = goal; },
        markLaneDead: (goal) => { laneMarked = goal; },
      });

      await tick.run();

      expect(killed).toHaveLength(0);
      expect(released).toBe('r1');
      expect(laneMarked).toBe('r1');
      const state = replay(journalPath);
      expect(state.events.some((e) => e.event === 'registry.reaped' && e.run === 'r1')).toBe(true);
    });

    it('never reaps a live pid or a row younger than the bound', async () => {
      let released = false;
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => 1_000_000,
        stuck: () => [],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        registryRows: () => [
          { goal: 'alive', cwd: 'x', briefPath: 'x', pid: 1, startedAt: 0 },
          { goal: 'young', cwd: 'x', briefPath: 'x', pid: 2, startedAt: 0 },
        ],
        isAlive: (pid) => pid === 1,
        parkedAt: () => 999_000,
        releaseRegistryRow: () => { released = true; },
      });

      await tick.run();

      expect(released).toBe(false);
      const state = replay(journalPath);
      expect(state.events.some((e) => e.event === 'registry.reaped')).toBe(false);
    });
  });

  describe('B.6: stale kill switch visibility', () => {
    it('journals warden.health once immediately while engaged, then again only after 30 minutes', async () => {
      let now = 0;
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => now,
        stuck: () => [],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        killSwitch: () => ({ engaged: true, reason: 'stop --all' }),
      });

      await tick.run();
      now += 5 * 60_000;
      await tick.run();
      now += 30 * 60_000;
      await tick.run();

      const state = replay(journalPath);
      const rows = state.events.filter((e) => e.event === 'warden.health' && e['key'] === 'kill-switch');
      expect(rows).toHaveLength(2);
    });

    it('never journals anything while disengaged', async () => {
      const tick = new WardenTick({
        journal, actuator, blockers: new BlockerBoard({ journal, actuator }),
        now: () => Date.now(),
        stuck: () => [],
        liveRuns: () => [],
        reportFleetHealth: () => 0,
        killSwitch: () => ({ engaged: false }),
      });

      await tick.run();
      await tick.run();

      const state = replay(journalPath);
      expect(state.events.some((e) => e.event === 'warden.health' && e['key'] === 'kill-switch')).toBe(false);
    });
  });
});

describe('DriftCadenceTracker (B.9)', () => {
  it('is due the first time a run is asked about, then not again until 10 turns pass', () => {
    const cadence = new DriftCadenceTracker(10, 5 * 60_000);
    expect(cadence.isDue('r1', 0, 0)).toBe(true);
    expect(cadence.isDue('r1', 3, 1_000)).toBe(false);
    expect(cadence.isDue('r1', 9, 2_000)).toBe(false);
    expect(cadence.isDue('r1', 10, 3_000)).toBe(true);
  });

  it('is also due once 5 minutes pass with no new turns', () => {
    const cadence = new DriftCadenceTracker(10, 5 * 60_000);
    expect(cadence.isDue('r1', 0, 0)).toBe(true);
    expect(cadence.isDue('r1', 1, 4 * 60_000)).toBe(false);
    expect(cadence.isDue('r1', 1, 5 * 60_000)).toBe(true);
  });

  it('tracks each run independently', () => {
    const cadence = new DriftCadenceTracker(10, 5 * 60_000);
    expect(cadence.isDue('r1', 0, 0)).toBe(true);
    expect(cadence.isDue('r2', 0, 0)).toBe(true);
    expect(cadence.isDue('r1', 5, 1_000)).toBe(false);
    expect(cadence.isDue('r2', 10, 1_000)).toBe(true);
  });
});
