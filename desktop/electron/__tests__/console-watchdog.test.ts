import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createConsoleWatchdog, PROBE_INTERVAL_MS, REVIVE_BACKOFF_MS, type ProbeResult, type ReviveResult, type WatchdogDeps,
} from '../console-watchdog';

type MockedWatchdogDeps = WatchdogDeps & {
  onGone: ReturnType<typeof vi.fn<(label: string) => void>>;
  onRevived: ReturnType<typeof vi.fn<() => void>>;
  onFailed: ReturnType<typeof vi.fn<(reason: string) => void>>;
  onLog: ReturnType<typeof vi.fn<(line: string) => void>>;
};

function makeDeps(overrides: Partial<WatchdogDeps> = {}): MockedWatchdogDeps {
  const base = {
    probe: vi.fn(async (): Promise<ProbeResult> => ({ reachable: true })),
    revive: vi.fn(async (): Promise<ReviveResult> => ({ ok: true })),
    onLog: vi.fn(),
    onGone: vi.fn(),
    onRevived: vi.fn(),
    onFailed: vi.fn(),
    now: () => new Date('2026-09-08T11:51:00').getTime(),
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  return { ...base, ...overrides } as MockedWatchdogDeps;
}

describe('createConsoleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two failed probes then a success: never declares the console gone', async () => {
    const results: ProbeResult[] = [{ reachable: false }, { reachable: false }, { reachable: true }];
    const probe = vi.fn(async () => results.shift()!);
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: true }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    }

    expect(probe).toHaveBeenCalledTimes(3);
    expect(revive).not.toHaveBeenCalled();
    expect(deps.onGone).not.toHaveBeenCalled();
  });

  it('three consecutive failures declares the console gone and revives exactly once', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ reachable: false }));
    let resolveRevive: (result: ReviveResult) => void = () => {};
    const revive = vi.fn(() => new Promise<ReviveResult>((resolve) => { resolveRevive = resolve; }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);

    expect(probe).toHaveBeenCalledTimes(3);
    expect(revive).toHaveBeenCalledTimes(1);
    expect(deps.onGone).toHaveBeenCalledTimes(1);
    expect(deps.onGone).toHaveBeenCalledWith('11:51');

    // Time keeps passing while the revive is pending -- no second revive starts,
    // and probing itself is paused (a revive already answers the question).
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 4);
    expect(revive).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(3);

    resolveRevive({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onRevived).toHaveBeenCalledTimes(1);
  });

  it('revive success calls onRevived once and probing resumes afterward', async () => {
    let failing = true;
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ reachable: !failing }));
    const revive = vi.fn(async (): Promise<ReviveResult> => {
      failing = false;
      return { ok: true };
    });
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);

    expect(revive).toHaveBeenCalledTimes(1);
    expect(deps.onRevived).toHaveBeenCalledTimes(1);

    const callsBefore = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 2);
    expect(probe.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(deps.onRevived).toHaveBeenCalledTimes(1);
  });

  it('revive failure reports the reason and does not probe again before the backoff', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ reachable: false }));
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: false, reason: 'the console did not answer within 600s' }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);

    expect(revive).toHaveBeenCalledTimes(1);
    expect(deps.onFailed).toHaveBeenCalledWith('the console did not answer within 600s');

    const callsAtFailure = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REVIVE_BACKOFF_MS - 1000);
    expect(probe.mock.calls.length).toBe(callsAtFailure);

    await vi.advanceTimersByTimeAsync(2000);
    expect(probe.mock.calls.length).toBeGreaterThan(callsAtFailure);
  });

  it('stop() cancels probing so no further probes or revives happen', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ reachable: false }));
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: true }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    watchdog.stop();
    const callsAtStop = probe.mock.calls.length;

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 5);
    expect(probe.mock.calls.length).toBe(callsAtStop);
    expect(revive).not.toHaveBeenCalled();
  });

  it('retryNow() triggers an immediate revive attempt, bypassing backoff', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ reachable: false }));
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: false, reason: 'still down' }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);
    expect(revive).toHaveBeenCalledTimes(1);

    watchdog.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(revive).toHaveBeenCalledTimes(2);
  });
});
