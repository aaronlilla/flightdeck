/**
 * Nothing today knows how long a run has been going. `RunState.startedAt` (added in
 * `journal.ts` for this goal) makes the elapsed time computable; this turns it into a
 * park the first time a run crosses its class's `maxWallMs` (`model-policy.json`), and
 * never parks it a second time for the same overrun.
 */
export interface SessionClockRun {
  run: string;
  startedAt?: number;
  className?: string;
}

export interface SessionClockActuator {
  park(run: string, reason: string): unknown;
}

export interface SessionClockInput {
  liveRuns: () => SessionClockRun[];
  maxWallMsFor: (className: string | undefined) => number | undefined;
  actuator: SessionClockActuator;
  now: () => number;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

/** Tracks which runs this process has already parked for wall clock, so a run over
 *  budget is parked once, not every tick until someone resumes it. Module-level state
 *  is fine here the same way `DriftCadenceTracker` instances are: one per `forge up`
 *  process, reset on restart, which is exactly when a fresh clock read is correct. */
export class SessionClock {
  private readonly parked = new Set<string>();

  /** Elapsed milliseconds for every run this tick has visibility into, for the lane
   *  glance's plain-English "running 42 min" line. A run with no `startedAt` (a torn
   *  journal, or a row from before this field existed) is omitted rather than guessed. */
  elapsed(runs: SessionClockRun[], now: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const run of runs) {
      if (run.startedAt !== undefined) out[run.run] = now - run.startedAt;
    }
    return out;
  }

  /** One tick's worth of wall-clock enforcement: park every live run whose elapsed time
   *  has newly crossed its class's budget. A run no longer live (finished, parked,
   *  handed off) drops out of `parked` so a later run reusing the same key starts clean. */
  tick(input: SessionClockInput): void {
    const now = input.now();
    const live = input.liveRuns();
    const liveKeys = new Set(live.map((run) => run.run));
    for (const key of [...this.parked]) {
      if (!liveKeys.has(key)) this.parked.delete(key);
    }
    for (const run of live) {
      if (run.startedAt === undefined) continue;
      if (this.parked.has(run.run)) continue;
      const budget = input.maxWallMsFor(run.className);
      if (budget === undefined) continue;
      const elapsedMs = now - run.startedAt;
      if (elapsedMs <= budget) continue;
      this.parked.add(run.run);
      input.actuator.park(run.run, `wall clock: ${formatDuration(elapsedMs)} over ${formatDuration(budget)}`);
    }
  }
}
