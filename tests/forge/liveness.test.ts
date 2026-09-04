/**
 * Reading whether the fleet is stuck, against a synthetic snapshot.
 *
 * No real process list anywhere here: every reader `assess` and `LivenessSupervisor` take
 * is injected, which is what lets a boundary be tested to the millisecond instead of
 * waited for.
 */
import { describe, expect, it } from 'vitest';

import { assess, DEFAULT_THRESHOLDS, LivenessSupervisor, type LivenessInput } from '../../src/forge/liveness.js';
import { contextFor } from '../../src/forge/policy.js';

const NOW = 1_000_000_000;

function baseInput(overrides: Partial<LivenessInput> = {}): LivenessInput {
  return { now: NOW, runs: [], fleet: [], ...overrides };
}

describe('the idle signal', () => {
  it('is silent one second inside the threshold', () => {
    const trips = assess(baseInput({
      runs: [{ run: 'r1', className: 'implement', lastEventAt: NOW - (DEFAULT_THRESHOLDS.idleMs - 1000), context: 0 }],
    }));
    expect(trips.some((t) => t.signal === 'idle')).toBe(false);
  });

  it('trips once the threshold is reached', () => {
    const trips = assess(baseInput({
      runs: [{ run: 'r1', className: 'implement', lastEventAt: NOW - DEFAULT_THRESHOLDS.idleMs, context: 0 }],
    }));
    const trip = trips.find((t) => t.signal === 'idle');
    expect(trip).toBeTruthy();
    expect(trip?.key).toBe('r1');
    expect(trip?.hint).toMatch(/r1/);
  });
});

describe('the tool-budget signal', () => {
  it('is silent one second inside the class budget', () => {
    const trips = assess(baseInput({
      runs: [{
        run: 'r1', className: 'implement', lastEventAt: NOW,
        currentTool: { name: 'Bash', startedAt: NOW - (900_000 - 1000), cls: 'test' },
        context: 0,
      }],
    }));
    expect(trips.some((t) => t.signal === 'tool-budget')).toBe(false);
  });

  it('trips once a tool call outruns its class budget', () => {
    const trips = assess(baseInput({
      runs: [{
        run: 'r1', className: 'implement', lastEventAt: NOW,
        currentTool: { name: 'Bash', startedAt: NOW - 900_000, cls: 'test' },
        context: 0,
      }],
    }));
    const trip = trips.find((t) => t.signal === 'tool-budget');
    expect(trip).toBeTruthy();
    expect(trip?.hint).toMatch(/Bash/);
  });
});

describe('the context signal', () => {
  it('is silent one token inside the class ceiling', () => {
    const trips = assess(baseInput({
      runs: [{ run: 'r1', className: 'implement', lastEventAt: NOW, context: 1 }],
    }));
    expect(trips.some((t) => t.signal === 'context')).toBe(false);
  });

  it('trips once context reaches the class ceiling', () => {
    const ceiling = contextFor('implement');
    const trips = assess(baseInput({
      runs: [{ run: 'r1', className: 'implement', lastEventAt: NOW, context: ceiling }],
    }));
    const trip = trips.find((t) => t.signal === 'context');
    expect(trip).toBeTruthy();
    expect(trip?.observed).toBe(ceiling);
  });
});

describe('the stale-session signal', () => {
  it('is silent one second inside the threshold', () => {
    const trips = assess(baseInput({
      fleet: [{ pid: 111, isLogin: false, sessionFileMtime: NOW - (DEFAULT_THRESHOLDS.staleSessionMs - 1000) }],
    }));
    expect(trips.some((t) => t.signal === 'stale-session')).toBe(false);
  });

  it('trips once a fleet session file goes stale', () => {
    const trips = assess(baseInput({
      fleet: [{ pid: 111, isLogin: false, sessionFileMtime: NOW - DEFAULT_THRESHOLDS.staleSessionMs }],
    }));
    const trip = trips.find((t) => t.signal === 'stale-session');
    expect(trip).toBeTruthy();
    expect(trip?.key).toBe('pid:111');
  });
});

describe('the login-stuck signal', () => {
  it('is silent one second inside the grace period', () => {
    const trips = assess(baseInput({
      fleet: [{ pid: 222, isLogin: true, credentialsMtime: NOW - (DEFAULT_THRESHOLDS.loginGraceMs - 1000) }],
    }));
    expect(trips.some((t) => t.signal === 'login-stuck')).toBe(false);
  });

  it('trips once a login process outlives its grace period, using the injected clock and mtime', () => {
    const trips = assess(baseInput({
      fleet: [{ pid: 222, isLogin: true, credentialsMtime: NOW - DEFAULT_THRESHOLDS.loginGraceMs }],
    }));
    const trip = trips.find((t) => t.signal === 'login-stuck');
    expect(trip).toBeTruthy();
    expect(trip?.key).toBe('pid:222');
  });
});

describe('the supervisor', () => {
  it('journals a new trip once and does not repeat it on the next tick', () => {
    const journaled: Record<string, unknown>[] = [];
    const published: Record<string, unknown>[] = [];
    let now = NOW;
    const supervisor = new LivenessSupervisor(
      () => baseInput({
        now,
        runs: [{ run: 'r1', className: 'implement', lastEventAt: now - DEFAULT_THRESHOLDS.idleMs, context: 0 }],
      }),
      { append: (e) => journaled.push(e) },
      (e) => published.push(e),
    );

    supervisor.evaluate();
    now += 1000;
    supervisor.evaluate();

    const stuckEvents = journaled.filter((e) => e['event'] === 'liveness.stuck');
    expect(stuckEvents).toHaveLength(1);
    expect(published.filter((e) => e['event'] === 'liveness.stuck')).toHaveLength(1);
  });

  it('journals a clear exactly once when the condition goes away', () => {
    const journaled: Record<string, unknown>[] = [];
    let stuck = true;
    const supervisor = new LivenessSupervisor(
      () => baseInput({
        runs: stuck
          ? [{ run: 'r1', className: 'implement', lastEventAt: NOW - DEFAULT_THRESHOLDS.idleMs, context: 0 }]
          : [{ run: 'r1', className: 'implement', lastEventAt: NOW, context: 0 }],
      }),
      { append: (e) => journaled.push(e) },
      () => {},
    );

    supervisor.evaluate();
    stuck = false;
    supervisor.evaluate();
    supervisor.evaluate();

    const cleared = journaled.filter((e) => e['event'] === 'liveness.cleared');
    expect(cleared).toHaveLength(1);
    expect(supervisor.stuck()).toHaveLength(0);
  });
});
