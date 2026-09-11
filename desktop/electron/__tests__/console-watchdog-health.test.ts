import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createConsoleWatchdog, PROBE_INTERVAL_MS, type HealthProbeResult, type ReviveResult, type WatchdogDeps,
} from '../console-watchdog';

type MockedWatchdogDeps = WatchdogDeps & {
  onGone: ReturnType<typeof vi.fn<(label: string) => void>>;
  onRevived: ReturnType<typeof vi.fn<() => void>>;
  onFailed: ReturnType<typeof vi.fn<(reason: string) => void>>;
  onLog: ReturnType<typeof vi.fn<(line: string) => void>>;
};

function makeDeps(overrides: Partial<WatchdogDeps> = {}): MockedWatchdogDeps {
  const base = {
    probe: vi.fn(async (): Promise<HealthProbeResult> => ({ health: 'up-healthy' })),
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
  };
  return { ...base, ...overrides } as MockedWatchdogDeps;
}

describe('createConsoleWatchdog health states', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('three consecutive up-no-console probes counts toward revive, same as down', async () => {
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ health: 'up-no-console' }));
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: true }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);

    expect(probe).toHaveBeenCalledTimes(3);
    expect(revive).toHaveBeenCalledTimes(1);
    expect(deps.onGone).toHaveBeenCalledTimes(1);
  });

  it('up-foreign never revives, however many probes come back that way', async () => {
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ health: 'up-foreign' }));
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: true }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 10);

    expect(probe).toHaveBeenCalledTimes(10);
    expect(revive).not.toHaveBeenCalled();
    expect(deps.onGone).not.toHaveBeenCalled();
  });

  it('up-healthy resets the failure count same as before', async () => {
    const results: HealthProbeResult[] = [
      { health: 'down' }, { health: 'down' }, { health: 'up-healthy' }, { health: 'down' }, { health: 'down' },
    ];
    const probe = vi.fn(async () => results.shift()!);
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: true }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 5);

    expect(probe).toHaveBeenCalledTimes(5);
    expect(revive).not.toHaveBeenCalled();
  });

  // Code-review finding, 2026-09-10: a probe slower than PROBE_INTERVAL_MS used to
  // let overlapping ticks start a second, third, fourth probe while the first was
  // still pending, racing on consecutiveFailures. probeHealth()'s own worst case
  // (up to three sequential 10s legs) against the 5s interval makes this reachable.
  it('a probe slower than the interval never lets a second overlapping probe start', async () => {
    let resolveProbe: (result: HealthProbeResult) => void = () => {};
    const probe = vi.fn(() => new Promise<HealthProbeResult>((resolve) => { resolveProbe = resolve; }));
    const revive = vi.fn(async (): Promise<ReviveResult> => ({ ok: true }));
    const deps = makeDeps({ probe, revive });
    const watchdog = createConsoleWatchdog(deps);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe({ health: 'up-healthy' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
