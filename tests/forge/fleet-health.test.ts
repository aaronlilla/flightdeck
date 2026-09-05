/**
 * fleet-unknown is reported, never acted on: evidence about the probe, not about a run.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExtendedStuckSignal } from '../../src/forge/contracts.js';
import { replayEvents } from '../../src/forge/contracts.js';
import { reportFleetHealth } from '../../src/forge/fleet-health.js';
import { Journal } from '../../src/forge/journal.js';

let home: string;
let journalPath: string;
let journal: Journal;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-fleet-health-'));
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
});

afterEach(() => {
  journal.close();
  rmSync(home, { recursive: true, force: true });
});

const FLEET_UNKNOWN: ExtendedStuckSignal = {
  key: 'fleet', signal: 'fleet-unknown', threshold: 0, observed: 0, since: 1,
  hint: 'the fleet process probe failed: pgrep not found',
};

describe('a fleet-unknown trip', () => {
  it('journals warden.health and nothing else', () => {
    const count = reportFleetHealth(journal, [FLEET_UNKNOWN]);
    expect(count).toBe(1);

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('warden.health');
    expect(events[0]?.['hint']).toMatch(/pgrep not found/);
  });

  it('takes no actuator parameter at all: the falsifier this closes is a caller wiring a park into it', () => {
    // The function's own arity is the proof: nothing here can reach `park`, `nudge`,
    // `resume` or `kill`, because none of those is a parameter it accepts.
    expect(reportFleetHealth.length).toBe(2);
  });
});

describe('an idle trip alongside a fleet-unknown one', () => {
  it('reports only the fleet-unknown trip, never a run-keyed signal', () => {
    const idle: ExtendedStuckSignal = {
      key: 'r1', signal: 'idle', threshold: 1, observed: 2, since: 1, hint: 'idle',
    };
    const count = reportFleetHealth(journal, [idle, FLEET_UNKNOWN]);
    expect(count).toBe(1);
    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    expect(events).toHaveLength(1);
  });
});
