/**
 * One async pass at a time. Copies `QueueTickRunner`'s own guard
 * (`intake/queueTickRunner.ts:125-126,154`, the `running` flag around a tick's promise):
 * a caller's `tick()` is a no-op while the previous call's pass has not settled, so a
 * slow pass can never overlap the next one. Used to wrap the 30s Warden/liveness tick
 * in `cli.ts`, which has no such guard of its own (audit finding #12,
 * `flightdeck-audit/03-code.md`).
 */
export class SingleFlightTick {
  private running = false;

  constructor(private readonly run: () => Promise<void>) {}

  /** Starts a pass unless one is already in flight. Never throws -- a `setInterval`
   *  callback's contract -- since `run()`'s own rejection is swallowed here. */
  readonly tick = (): void => {
    if (this.running) return;
    this.running = true;
    void this.run()
      .catch(() => undefined)
      .finally(() => { this.running = false; });
  };

  /** Whether a pass started by `tick()` has not settled yet. */
  get inFlight(): boolean {
    return this.running;
  }
}
