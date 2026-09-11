import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLoadLoop, STATUS_NOT_SERVING, type LoadLoopDeps } from '../load-loop';
import type { HealthResult } from '../probe';

function makeDeps(overrides: Partial<LoadLoopDeps> = {}): LoadLoopDeps & {
  probe: ReturnType<typeof vi.fn<() => Promise<HealthResult>>>;
  onStatus: ReturnType<typeof vi.fn<(text: string) => void>>;
  onLoaded: ReturnType<typeof vi.fn<() => void>>;
  loadURL: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const base = {
    probe: vi.fn(async (): Promise<HealthResult> => ({ health: 'up-healthy' })),
    loadURL: vi.fn(async () => {}),
    onStatus: vi.fn(),
    onLoaded: vi.fn(),
    pollIntervalMs: 2000,
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  return { ...base, ...overrides } as typeof base;
}

describe('createLoadLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not load until health reads up-healthy', async () => {
    const deps = makeDeps({ probe: vi.fn(async (): Promise<HealthResult> => ({ health: 'up-no-console' })) });
    const loop = createLoadLoop(deps);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.loadURL).not.toHaveBeenCalled();
    expect(deps.onStatus).toHaveBeenCalledWith(STATUS_NOT_SERVING);
  });

  it('a 404 main-frame response never stays loaded: status sink receives exactly STATUS_NOT_SERVING, never the JSON body, and polling resumes', async () => {
    const deps = makeDeps();
    const loop = createLoadLoop(deps);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.loadURL).toHaveBeenCalledTimes(1);
    loop.reportMainFrameStatus(404);

    expect(deps.onLoaded).not.toHaveBeenCalled();
    expect(deps.onStatus).toHaveBeenCalledWith(STATUS_NOT_SERVING);
    expect(deps.onStatus).not.toHaveBeenCalledWith(expect.stringContaining('nothing serves'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.probe).toHaveBeenCalledTimes(2);
    expect(deps.loadURL).toHaveBeenCalledTimes(2);
  });

  it('did-fail-load also returns to the status window and keeps polling', async () => {
    const deps = makeDeps();
    const loop = createLoadLoop(deps);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.reportFailLoad();

    expect(deps.onLoaded).not.toHaveBeenCalled();
    expect(deps.onStatus).toHaveBeenCalledWith(STATUS_NOT_SERVING);

    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.loadURL).toHaveBeenCalledTimes(2);
  });

  it('a 200 main-frame response loads the board and stops polling', async () => {
    const deps = makeDeps();
    const loop = createLoadLoop(deps);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.reportMainFrameStatus(200);

    expect(deps.onLoaded).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.probe).toHaveBeenCalledTimes(1);
  });

  it('second-instance (restart()) on a loop whose last outcome was non-2xx triggers an immediate new health poll and loadURL, not just a wait for the next interval', async () => {
    const deps = makeDeps();
    const loop = createLoadLoop(deps);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.reportMainFrameStatus(404);
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(deps.loadURL).toHaveBeenCalledTimes(1);

    loop.restart();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.probe).toHaveBeenCalledTimes(2);
    expect(deps.loadURL).toHaveBeenCalledTimes(2);
  });

  it('stop() halts polling entirely', async () => {
    const deps = makeDeps();
    const loop = createLoadLoop(deps);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.reportMainFrameStatus(404);
    loop.stop();
    const callsAtStop = deps.probe.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.probe.mock.calls.length).toBe(callsAtStop);
  });

  // Code-review finding, 2026-09-10: against the exact slow-console scenario
  // (probeHealth() taking up to ~30s worst case), the interval used to keep
  // firing new ticks -- and new overlapping probes -- while the first probe was
  // still in flight, because the re-entrancy guard was set only after the probe
  // resolved.
  it('a probe slower than the poll interval never lets a second overlapping probe start', async () => {
    let resolveProbe: (result: { health: 'up-healthy' }) => void = () => {};
    const probe = vi.fn(() => new Promise<{ health: 'up-healthy' }>((resolve) => { resolveProbe = resolve; }));
    const deps = makeDeps({ probe: probe as unknown as ReturnType<typeof vi.fn<() => Promise<HealthResult>>> });
    const loop = createLoadLoop(deps);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);

    // Three more interval ticks land while the first probe is still pending --
    // none of them may start a second probe.
    await vi.advanceTimersByTimeAsync(2000 * 3);
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe({ health: 'up-healthy' });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.loadURL).toHaveBeenCalledTimes(1);
  });
});
