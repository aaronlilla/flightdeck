/**
 * Nothing tracks elapsed time per run today. `SessionClock` parks a run once it crosses
 * its class's `maxWallMs`, and only once -- a run left parked (never resumed) must not
 * get a second identical park row every tick.
 */
import { describe, expect, it, vi } from 'vitest';

import { SessionClock } from '../../src/forge/session-clock.js';

describe('SessionClock', () => {
  it('parks a run that has run past its class budget, with the elapsed and budget in the reason', () => {
    const park = vi.fn();
    const clock = new SessionClock();
    clock.tick({
      liveRuns: () => [{ run: 'alpha', startedAt: 0, className: 'implement' }],
      maxWallMsFor: () => 10_800_000,
      actuator: { park },
      now: () => 10_800_000 + 60_000, // 1 minute over
    });
    expect(park).toHaveBeenCalledTimes(1);
    expect(park.mock.calls[0]?.[0]).toBe('alpha');
    // Plain words, not the name of the measurement: what a person reads off the board
    // says how long it has run and how long it was meant to (Aaron, 2026-09-12).
    const reason = String(park.mock.calls[0]?.[1]);
    expect(reason).toMatch(/^Running .+, expected .+$/);
    expect(reason).not.toMatch(/wall clock/);
  });

  it('does not park a run under budget', () => {
    const park = vi.fn();
    const clock = new SessionClock();
    clock.tick({
      liveRuns: () => [{ run: 'alpha', startedAt: 0, className: 'implement' }],
      maxWallMsFor: () => 10_800_000,
      actuator: { park },
      now: () => 100,
    });
    expect(park).not.toHaveBeenCalled();
  });

  it('parks an over-budget run once, and not again on the next tick', () => {
    const park = vi.fn();
    const clock = new SessionClock();
    const run = { run: 'alpha', startedAt: 0, className: 'implement' };
    const input = {
      liveRuns: () => [run],
      maxWallMsFor: () => 1_000,
      actuator: { park },
      now: () => 2_000,
    };
    clock.tick(input);
    clock.tick(input);
    clock.tick({ ...input, now: () => 3_000 });
    expect(park).toHaveBeenCalledTimes(1);
  });

  it('parks again if the run key is reused after the first run left liveRuns', () => {
    const park = vi.fn();
    const clock = new SessionClock();
    clock.tick({
      liveRuns: () => [{ run: 'alpha', startedAt: 0, className: 'implement' }],
      maxWallMsFor: () => 1_000,
      actuator: { park },
      now: () => 2_000,
    });
    // alpha finishes and drops out of liveRuns for a tick
    clock.tick({ liveRuns: () => [], maxWallMsFor: () => 1_000, actuator: { park }, now: () => 2_500 });
    // a fresh run reuses the key alpha, started at 3_000
    clock.tick({
      liveRuns: () => [{ run: 'alpha', startedAt: 3_000, className: 'implement' }],
      maxWallMsFor: () => 1_000,
      actuator: { park },
      now: () => 5_000,
    });
    expect(park).toHaveBeenCalledTimes(2);
  });

  it('skips a run with no startedAt rather than guessing', () => {
    const park = vi.fn();
    const clock = new SessionClock();
    clock.tick({
      liveRuns: () => [{ run: 'alpha', className: 'implement' }],
      maxWallMsFor: () => 1,
      actuator: { park },
      now: () => 1_000_000,
    });
    expect(park).not.toHaveBeenCalled();
  });

  it('skips a class with no configured budget', () => {
    const park = vi.fn();
    const clock = new SessionClock();
    clock.tick({
      liveRuns: () => [{ run: 'alpha', startedAt: 0, className: 'unknown-class' }],
      maxWallMsFor: () => undefined,
      actuator: { park },
      now: () => 999_999_999,
    });
    expect(park).not.toHaveBeenCalled();
  });

  it('elapsed() reports plain milliseconds per run, omitting one with no startedAt', () => {
    const clock = new SessionClock();
    const elapsed = clock.elapsed(
      [{ run: 'alpha', startedAt: 1_000 }, { run: 'beta' }],
      6_000,
    );
    expect(elapsed).toEqual({ alpha: 5_000 });
  });
});
