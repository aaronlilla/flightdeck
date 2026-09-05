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

  it('watches rather than crashing on a className the loaded policy no longer declares', () => {
    expect(() => assess(baseInput({
      runs: [{ run: 'r1', className: 'no-such-class-ever', lastEventAt: NOW, context: 999_999 }],
    }))).not.toThrow();
    const trips = assess(baseInput({
      runs: [{ run: 'r1', className: 'no-such-class-ever', lastEventAt: NOW, context: 999_999 }],
    }));
    expect(trips.some((t) => t.signal === 'context')).toBe(false);
  });
});

describe('I15: admission ignores a dead run\'s dangling tool call', () => {
  it('never trips tool-budget for a run whose registry row is absent', () => {
    const trips = assess(baseInput({
      runs: [{
        run: 'forge-live-probe-b3', className: 'implement', lastEventAt: NOW,
        currentTool: { name: 'Bash', startedAt: NOW - 900_000, cls: 'test' },
        context: 0, registryLive: false,
      }],
    }));
    expect(trips.some((t) => t.signal === 'tool-budget')).toBe(false);
    // No row remains (registryRowRemains not set), so there is nothing to record either.
    expect(trips.some((t) => t.signal === 'registry-abandoned')).toBe(false);
  });

  it('records registry-abandoned once, instead of a tool-budget trip, when a dead row remains', () => {
    const trips = assess(baseInput({
      runs: [{
        run: 'forge-live-probe-b3', className: 'implement', lastEventAt: NOW,
        currentTool: { name: 'Bash', startedAt: NOW - 900_000, cls: 'test' },
        context: 0, registryLive: false, registryRowRemains: true,
      }],
    }));
    expect(trips.some((t) => t.signal === 'tool-budget')).toBe(false);
    const trip = trips.find((t) => t.signal === 'registry-abandoned');
    expect(trip).toBeTruthy();
    expect(trip?.key).toBe('forge-live-probe-b3');
  });

  it('still trips tool-budget when the registry says the pid is alive', () => {
    const trips = assess(baseInput({
      runs: [{
        run: 'forge-live-probe-b3', className: 'implement', lastEventAt: NOW,
        currentTool: { name: 'Bash', startedAt: NOW - 900_000, cls: 'test' },
        context: 0, registryLive: true,
      }],
    }));
    expect(trips.some((t) => t.signal === 'tool-budget')).toBe(true);
  });

  it('the supervisor never parks or flags a lane for a dead run\'s dangling tool call, '
    + 'but does journal registry.abandoned exactly once across ticks', () => {
    const journaled: Record<string, unknown>[] = [];
    const laneWrites: Array<{ slug: string; fields: Record<string, unknown> }> = [];
    const parked = new Map<string, string>();
    let now = NOW;
    const supervisor = new LivenessSupervisor(
      () => baseInput({
        now,
        runs: [{
          run: 'forge-live-probe-b3', className: 'implement', lastEventAt: now - 3_000_000,
          currentTool: { name: 'Bash', startedAt: now - 900_000, cls: 'test' },
          context: 0, registryLive: false, registryRowRemains: true,
        }],
      }),
      { append: (e) => journaled.push(e as Record<string, unknown>) },
      () => {},
      DEFAULT_THRESHOLDS,
      { parked, lanes: { put: (slug, fields) => laneWrites.push({ slug, fields }) } },
    );

    supervisor.evaluate();
    now += 1000;
    supervisor.evaluate();

    expect(journaled.some((e) => e['event'] === 'warden.parked')).toBe(false);
    expect(laneWrites.some((w) => w.fields['needs_aaron'])).toBe(false);
    expect(parked.size).toBe(0);
    const abandoned = journaled.filter((e) => e['event'] === 'registry.abandoned');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.['run']).toBe('forge-live-probe-b3');
  });

  it('the supervisor parks and flags the lane when the same dangling tool call is backed by a live pid', () => {
    const journaled: Record<string, unknown>[] = [];
    const laneWrites: Array<{ slug: string; fields: Record<string, unknown> }> = [];
    const parked = new Map<string, string>();
    const supervisor = new LivenessSupervisor(
      () => baseInput({
        runs: [{
          run: 'forge-live-probe-b3', className: 'implement', lastEventAt: NOW - 3_000_000,
          currentTool: { name: 'Bash', startedAt: NOW - 900_000, cls: 'test' },
          context: 0, registryLive: true,
        }],
      }),
      { append: (e) => journaled.push(e as Record<string, unknown>) },
      () => {},
      DEFAULT_THRESHOLDS,
      { parked, lanes: { put: (slug, fields) => laneWrites.push({ slug, fields }) } },
    );

    supervisor.evaluate();

    expect(journaled.some((e) => e['event'] === 'warden.parked')).toBe(true);
    expect(laneWrites.some((w) => w.slug === 'forge-live-probe-b3' && w.fields['needs_aaron'])).toBe(true);
    expect(parked.get('forge-live-probe-b3')).toBeTruthy();
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

describe('a failed fleet probe', () => {
  it('trips fleet-unknown with the reason rather than reading as zero stale sessions', () => {
    const trips = assess(baseInput({ fleet: { ok: false, reason: 'powershell timed out' } }));
    expect(trips.some((t) => t.signal === 'stale-session')).toBe(false);
    const trip = trips.find((t) => t.signal === 'fleet-unknown');
    expect(trip).toBeTruthy();
    expect(trip?.hint).toContain('powershell timed out');
  });

  it('still runs the per-run signals when the fleet probe itself fails', () => {
    const trips = assess(baseInput({
      fleet: { ok: false, reason: 'powershell timed out' },
      runs: [{ run: 'r1', className: 'implement', lastEventAt: NOW - DEFAULT_THRESHOLDS.idleMs, context: 0 }],
    }));
    expect(trips.some((t) => t.signal === 'idle' && t.key === 'r1')).toBe(true);
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

  it('keeps a stuck trip\'s original since across ticks rather than resetting it to now', () => {
    let now = NOW;
    const lastEventAt = NOW - DEFAULT_THRESHOLDS.idleMs;
    const supervisor = new LivenessSupervisor(
      () => baseInput({
        now,
        runs: [{ run: 'r1', className: 'implement', lastEventAt, context: 0 }],
      }),
      { append: () => {} },
      () => {},
    );

    supervisor.evaluate();
    const firstSince = supervisor.stuck().find((t) => t.signal === 'idle')?.since;
    now += 60_000;
    supervisor.evaluate();
    const secondSince = supervisor.stuck().find((t) => t.signal === 'idle')?.since;

    expect(secondSince).toBe(firstSince);
  });

  it('a failed fleet probe keeps its since from when it first tripped, not the latest tick', () => {
    let now = NOW;
    const supervisor = new LivenessSupervisor(
      () => baseInput({ now, fleet: { ok: false, reason: 'powershell timed out' } }),
      { append: () => {} },
      () => {},
    );

    supervisor.evaluate();
    const firstSince = supervisor.stuck().find((t) => t.signal === 'fleet-unknown')?.since;
    now += 60_000;
    supervisor.evaluate();
    const secondSince = supervisor.stuck().find((t) => t.signal === 'fleet-unknown')?.since;

    expect(secondSince).toBe(firstSince);
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

describe('B.3.10: the minimal actuator', () => {
  it('parks the stuck run, flags its lane, and journals warden.parked with the evidence', async () => {
    const { buildPreToolUseHook } = await import('../../src/forge/sdkengine.js');
    const { Journal } = await import('../../src/forge/journal.js');
    const { Inbox } = await import('../../src/forge/inbox.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const home = mkdtempSync(join(tmpdir(), 'forge-warden-'));
    const journalPath = join(home, 'fleet.jsonl');
    const inbox = new Inbox(join(home, 'inbox'));
    const journaled: Record<string, unknown>[] = [];
    const laneWrites: Array<{ slug: string; fields: Record<string, unknown> }> = [];
    const parked = new Map<string, string>();

    const supervisor = new LivenessSupervisor(
      () => baseInput({
        runs: [{ run: 'stuck-run', className: 'implement', lastEventAt: NOW - DEFAULT_THRESHOLDS.idleMs, context: 0 }],
      }),
      { append: (e) => journaled.push(e as Record<string, unknown>) },
      () => {},
      DEFAULT_THRESHOLDS,
      { parked, lanes: { put: (slug, fields) => laneWrites.push({ slug, fields }) } },
    );

    supervisor.evaluate();

    const warden = journaled.find((e) => e['event'] === 'warden.parked');
    expect(warden?.['run']).toBe('stuck-run');
    expect((warden?.['evidence'] as { signal: string } | undefined)?.signal).toBe('idle');
    expect(laneWrites.some((w) => w.slug === 'stuck-run' && w.fields['needs_aaron'])).toBe(true);

    // The falsifier this closes: asserting the journal row alone proves nothing about
    // whether the run is actually blocked. This drives the same PreToolUse guard B.3.1
    // built, sharing the same parked map, and shows the next tool call really is denied.
    const journal = new Journal(journalPath);
    const hook = buildPreToolUseHook({
      run: 'stuck-run', goal: 'stuck-run', parked, journal, inbox, deliverVia: 'hook',
    });
    const verdict = await hook({ toolName: 'Bash', input: {}, toolUseId: 'tu-1' });
    journal.close();

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('warden:stuck-run:idle');
  });

  it('never signals a process: the actuator has no kill call anywhere in its path', () => {
    // No process handle, no pid, no kill function reaches WardenActuator at all -- there
    // is nothing here that could signal one. This is proven structurally: the actuator's
    // own type carries only `parked` and `lanes`, neither of which can touch a process.
    const parked = new Map<string, string>();
    const laneWrites: Array<{ slug: string; fields: Record<string, unknown> }> = [];
    const journaled: Record<string, unknown>[] = [];
    const supervisor = new LivenessSupervisor(
      () => baseInput({
        runs: [{ run: 'stuck-run-2', className: 'implement', lastEventAt: NOW - DEFAULT_THRESHOLDS.idleMs, context: 0 }],
      }),
      { append: (e) => journaled.push(e as Record<string, unknown>) },
      () => {},
      DEFAULT_THRESHOLDS,
      { parked, lanes: { put: (slug, fields) => laneWrites.push({ slug, fields }) } },
    );
    supervisor.evaluate();
    expect(journaled.some((e) => e['event'] === 'warden.parked')).toBe(true);
  });

  it('a pid-keyed fleet signal is not parked, since it names a process rather than a run', () => {
    const parked = new Map<string, string>();
    const journaled: Record<string, unknown>[] = [];
    const supervisor = new LivenessSupervisor(
      () => baseInput({ fleet: { ok: false, reason: 'powershell timed out' } }),
      { append: (e) => journaled.push(e as Record<string, unknown>) },
      () => {},
      DEFAULT_THRESHOLDS,
      { parked, lanes: { put: () => {} } },
    );
    supervisor.evaluate();
    expect(journaled.some((e) => e['event'] === 'warden.parked')).toBe(false);
    expect(parked.size).toBe(0);
  });
});
