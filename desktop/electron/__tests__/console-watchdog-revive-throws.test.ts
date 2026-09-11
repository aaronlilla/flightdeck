import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createConsoleWatchdog, PROBE_INTERVAL_MS, REVIVE_BACKOFF_MS, type HealthProbeResult, type ReviveResult, type WatchdogDeps,
} from '../console-watchdog';

function makeDeps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    probe: vi.fn(async (): Promise<HealthProbeResult> => ({ health: 'down' })),
    revive: vi.fn(async (): Promise<ReviveResult> => ({ ok: true })),
    onLog: vi.fn(),
    onGone: vi.fn(),
    onRevived: vi.fn(),
    onFailed: vi.fn(),
    now: () => new Date('2026-09-10T19:00:00').getTime(),
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...overrides,
  };
}

describe('createConsoleWatchdog: revive() throwing instead of resolving', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a synchronously-throwing revive() still recovers: reviving resets, backoff runs, probing resumes', async () => {
    let shouldThrow = true;
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ health: 'down' }));
    const revive = vi.fn(async (): Promise<ReviveResult> => {
      if (shouldThrow) throw new Error('git binary not found');
      return { ok: true };
    });
    const onFailed = vi.fn();
    const deps = makeDeps({ probe, revive, onFailed });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);

    expect(revive).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining('git binary not found'));

    // The watchdog must not be permanently dead: after the backoff, probing resumes
    // and a second revive attempt is reachable (not stuck with reviving still true).
    shouldThrow = false;
    const probeCallsAtFailure = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REVIVE_BACKOFF_MS + PROBE_INTERVAL_MS * 3);

    expect(probe.mock.calls.length).toBeGreaterThan(probeCallsAtFailure);
    expect(revive).toHaveBeenCalledTimes(2);
  });
});
