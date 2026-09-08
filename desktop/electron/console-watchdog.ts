/**
 * Watches the console at 127.0.0.1:4120 while the board is on screen, and
 * brings it back on its own if it goes away for good.
 *
 * Probes run on a fixed interval. Three misses in a row (not one) count as
 * "gone" -- a self-cutover restart takes a few seconds to come back up, and
 * that gap must never read as death. Once gone is declared, probing pauses
 * and a single revive attempt runs; nothing starts a second revive while
 * one is already in flight. A revive that succeeds resumes normal probing
 * right away. A revive that fails reports why and waits out a backoff
 * before probing again, so a console that cannot come back is not hammered
 * every few seconds.
 *
 * All I/O -- the probe, the revive call, the clock, the timers -- is
 * injected, so the whole thing runs under a test's fake clock with no real
 * socket or process involved.
 */

export interface ProbeResult {
  reachable: boolean;
}

export type ReviveResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface WatchdogDeps {
  probe(): Promise<ProbeResult>;
  /** Runs a full bring-up attempt again (the same one bootstrap used) and
   *  reports whether the console answered. */
  revive(): Promise<ReviveResult>;
  onLog(line: string): void;
  /** Three probes in a row came back unreachable. `label` is the time that
   *  was declared, formatted for a person to read ("11:51"). */
  onGone(label: string): void;
  /** The revive attempt brought the console back. */
  onRevived(): void;
  /** The revive attempt did not bring the console back; `reason` is the
   *  same failure text `bringUpConsole` reports on `start-failed`. */
  onFailed(reason: string): void;
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConsoleWatchdog {
  start(): void;
  stop(): void;
  /** Runs a revive attempt right now, bypassing any post-failure backoff --
   *  what the status window's Retry button calls. A no-op while a revive is
   *  already in flight. */
  retryNow(): void;
}

/** How often the console is probed while things look fine. */
export const PROBE_INTERVAL_MS = 5_000;

/** Consecutive misses before the console is declared gone: three probes at
 *  the interval above is 15s of silence, long enough that a self-cutover
 *  restart is never mistaken for death. */
export const FAILURE_THRESHOLD = 3;

/** How long to wait before probing again after a revive attempt fails. */
export const REVIVE_BACKOFF_MS = 30_000;

function formatClockLabel(epochMs: number): string {
  const asDate = new Date(epochMs);
  const hours = String(asDate.getHours()).padStart(2, '0');
  const minutes = String(asDate.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function createConsoleWatchdog(deps: WatchdogDeps): ConsoleWatchdog {
  let intervalHandle: unknown;
  let backoffHandle: unknown;
  let consecutiveFailures = 0;
  let reviving = false;
  let stopped = true;

  function clearProbeInterval(): void {
    if (intervalHandle !== undefined) {
      deps.clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
  }

  function clearBackoff(): void {
    if (backoffHandle !== undefined) {
      deps.clearTimeout(backoffHandle);
      backoffHandle = undefined;
    }
  }

  function scheduleProbing(): void {
    clearProbeInterval();
    if (stopped) return;
    intervalHandle = deps.setInterval(() => { void tick(); }, PROBE_INTERVAL_MS);
  }

  async function tick(): Promise<void> {
    if (stopped || reviving) return;
    const result = await deps.probe();
    if (stopped || reviving) return;
    if (result.reachable) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      await goneAndRevive();
    }
  }

  async function goneAndRevive(): Promise<void> {
    reviving = true;
    clearProbeInterval();
    clearBackoff();
    const label = formatClockLabel(deps.now());
    deps.onLog(`the console at 127.0.0.1:4120 has not answered for ${PROBE_INTERVAL_MS * FAILURE_THRESHOLD / 1000}s; declaring it gone at ${label} and bringing it back`);
    deps.onGone(label);

    const result = await deps.revive();
    consecutiveFailures = 0;
    reviving = false;
    if (stopped) return;

    if (result.ok) {
      deps.onLog('the console answered again; back on the board');
      deps.onRevived();
      scheduleProbing();
      return;
    }

    deps.onLog(`bringing the console back failed: ${result.reason}`);
    deps.onFailed(result.reason);
    backoffHandle = deps.setTimeout(() => {
      backoffHandle = undefined;
      if (stopped) return;
      // Probe right away rather than waiting a further interval on top of
      // the backoff -- "wait 30s before probing again" means the next
      // probe lands at the 30s mark, not 30s-plus-interval.
      scheduleProbing();
      void tick();
    }, REVIVE_BACKOFF_MS);
  }

  return {
    start(): void {
      stopped = false;
      consecutiveFailures = 0;
      scheduleProbing();
    },
    stop(): void {
      stopped = true;
      clearProbeInterval();
      clearBackoff();
    },
    retryNow(): void {
      if (reviving || stopped) return;
      clearBackoff();
      clearProbeInterval();
      void goneAndRevive();
    },
  };
}
