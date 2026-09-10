/**
 * The graceful stop the console has never had.
 *
 * `cli.ts` today handles only `unhandledRejection` and a bare `process.once('exit', ...)`
 * that releases the queue lock -- SIGTERM or SIGINT just kill the process mid-tick,
 * mid-lock, mid-request. A service that cannot stop cleanly corrupts the queue lock file
 * and drops an in-flight council round. This wires SIGINT, SIGTERM and Windows SIGBREAK
 * to: clear the tick so nothing fires mid-shutdown, close the server (which waits for
 * in-flight requests, bounded by `closeTimeoutMs` so a stuck request cannot hang the
 * service manager's stop forever), release the queue lock if this process held one,
 * journal `console.stopped {reason}`, close the journal, and exit 0 -- once, no matter how
 * many signals arrive (NSSM can send more than one during a stop).
 */
export interface ShutdownServer {
  close(): Promise<void>;
}

export interface ShutdownQueueLock {
  release(): void;
}

export interface ShutdownJournal {
  append(event: Record<string, unknown>): unknown;
  close(): void;
}

export interface InstallShutdownInput {
  server: ShutdownServer;
  /** Stops the 30s tick. Passed as a function rather than the raw `Timeout` so a caller
   *  can hand in `() => clearInterval(tick)` without this module importing timer types
   *  it does not otherwise need. */
  clearTick: () => void;
  queueLock?: ShutdownQueueLock;
  journal: ShutdownJournal;
  /** Test seam: production never sets this, and gets the real `process.exit`. */
  onExit?: (code: number) => void;
  /** Test seam: production never sets this, and gets the real `process`. */
  process?: NodeJS.Process;
  /** Bounds how long shutdown waits on `server.close()`. Default 10s per the brief. */
  closeTimeoutMs?: number;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

/** Wires the signal handlers and returns a function that runs the same sequence
 *  on demand (unused in production today, kept for a future manual-stop route). */
export function installShutdown(input: InstallShutdownInput): (reason: string) => Promise<void> {
  const proc = input.process ?? process;
  const exit = input.onExit ?? ((code: number) => { proc.exit(code); });
  const closeTimeoutMs = input.closeTimeoutMs ?? 10_000;
  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    input.clearTick();
    await Promise.race([
      input.server.close(),
      new Promise<void>((resolve) => { setTimeout(resolve, closeTimeoutMs); }),
    ]);
    input.queueLock?.release();
    input.journal.append({ event: 'console.stopped', actor: 'console', reason });
    input.journal.close();
    exit(0);
  }

  for (const signal of SIGNALS) {
    proc.on(signal, () => { void shutdown(signal); });
  }

  return shutdown;
}
