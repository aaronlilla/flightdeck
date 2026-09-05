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
import { Registry } from '../../src/forge/registry.js';
import { WardenActuator } from '../../src/forge/warden.js';
import { WardenTick } from '../../src/forge/warden-tick.js';
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
});
