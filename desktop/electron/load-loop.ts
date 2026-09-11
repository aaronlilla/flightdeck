/**
 * Never a stranded 404 (item 2, plan step 7, 2026-09-10).
 *
 * Before this, `main.ts` loaded `/` once, kept whatever came back (404 body
 * included) until a manual reload, and the watchdog's blind probe never
 * noticed a page that loaded but served nothing. This loop only calls
 * `loadURL` once health reads `up-healthy`, and any main-frame response that
 * is not 2xx -- or a `did-fail-load` -- sends it straight back to the status
 * window with a plain sentence and keeps polling, rather than leaving
 * whatever body the browser already painted on screen.
 *
 * Kept free of Electron: `deps.loadURL` and the two `report*` methods are the
 * seam a real `webContents` wiring calls into (`onHeadersReceived` for the
 * main frame, `did-fail-load`), so this whole state machine runs under a
 * test's fake timers with a fake `loadURL`/status sink, no real window
 * involved.
 */
import type { HealthResult } from './probe';

export const STATUS_NOT_SERVING = 'The console is running but is not serving its page yet — waiting for it.';

export interface LoadLoopDeps {
  probe(): Promise<HealthResult>;
  /** Starts a navigation to the console's `/`. The loop does not itself know
   *  whether it succeeded -- that comes back through `reportMainFrameStatus`
   *  or `reportFailLoad`, called by the real `webContents` listeners this
   *  navigation triggers. */
  loadURL(): Promise<void>;
  onStatus(text: string): void;
  onLoaded(): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  pollIntervalMs?: number;
}

export interface LoadLoop {
  start(): void;
  stop(): void;
  /** The status code of the main-frame response to the navigation this loop's
   *  last `loadURL` triggered. Ignored if no load is in flight (a stray
   *  response for a navigation this loop did not start, or one already
   *  resolved). */
  reportMainFrameStatus(statusCode: number): void;
  /** `did-fail-load` for the in-flight navigation. */
  reportFailLoad(): void;
  /** `second-instance`: re-run the loop right now on the existing window
   *  instead of trusting whatever it currently shows -- a stale instance
   *  sitting on a 404 reloads when the shortcut is clicked again. */
  restart(): void;
}

const DEFAULT_POLL_MS = 2_000;

export function createLoadLoop(deps: LoadLoopDeps): LoadLoop {
  let intervalHandle: unknown;
  let stopped = true;
  let awaitingResponse = false;

  function clearPoll(): void {
    if (intervalHandle !== undefined) {
      deps.clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
  }

  function schedule(): void {
    clearPoll();
    if (stopped) return;
    intervalHandle = deps.setInterval(() => { void tick(); }, deps.pollIntervalMs ?? DEFAULT_POLL_MS);
  }

  async function tick(): Promise<void> {
    if (stopped || awaitingResponse) return;
    // Code-review finding, 2026-09-10: the guard used to be set only after
    // `deps.probe()` resolved, not before it started -- against the exact slow
    // probe this diff exists to handle (a console answering in 15-33s;
    // `probeHealth()`'s own worst case is up to three sequential 10s legs), the
    // 2s poll interval fires several more `tick()` calls before the first
    // probe returns, each starting its own overlapping `probeHealth()` call.
    // Setting it here, before the probe even starts, closes that window.
    awaitingResponse = true;
    // Code-review finding, 2026-09-11: a rejection from deps.probe() (e.g.
    // consoleOrigin() throwing synchronously on a malformed
    // FORGE_CONSOLE_ORIGIN inside probeHealth()'s default-port argument) left
    // awaitingResponse stuck true forever -- every future tick() returned
    // immediately at the top guard, silently freezing the status window with
    // no log and no recovery short of an app restart.
    let result;
    try {
      result = await deps.probe();
    } catch {
      awaitingResponse = false;
      deps.onStatus(STATUS_NOT_SERVING);
      return;
    }
    if (stopped) { awaitingResponse = false; return; }
    if (result.health !== 'up-healthy') {
      awaitingResponse = false;
      deps.onStatus(STATUS_NOT_SERVING);
      return;
    }
    // A load is now in flight: pause polling (there is nothing useful to
    // probe again until this navigation resolves) until reportMainFrameStatus
    // or reportFailLoad settles it.
    clearPoll();
    try {
      await deps.loadURL();
    } catch {
      // loadURL()'s promise rejects on a failed navigation (did-fail-load);
      // reportFailLoad is the real recovery path (main.ts wires it to the
      // webContents event), but a rejection here must never leave polling
      // paused with nothing left to resume it.
      backToStatusAndKeepPolling();
    }
  }

  function backToStatusAndKeepPolling(): void {
    awaitingResponse = false;
    deps.onStatus(STATUS_NOT_SERVING);
    schedule();
  }

  return {
    start(): void {
      stopped = false;
      awaitingResponse = false;
      schedule();
      void tick();
    },
    stop(): void {
      stopped = true;
      clearPoll();
    },
    reportMainFrameStatus(statusCode: number): void {
      if (!awaitingResponse) return;
      if (statusCode >= 200 && statusCode < 300) {
        awaitingResponse = false;
        clearPoll();
        deps.onLoaded();
        return;
      }
      backToStatusAndKeepPolling();
    },
    reportFailLoad(): void {
      if (!awaitingResponse) return;
      backToStatusAndKeepPolling();
    },
    restart(): void {
      if (stopped) return;
      awaitingResponse = false;
      schedule();
      void tick();
    },
  };
}
