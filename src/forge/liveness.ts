/**
 * Reading whether the fleet is stuck, from evidence rather than a guess.
 *
 * Aaron, 2026-09-04 12:22: a claude login process sat for 95 minutes after its
 * credentials were written and nothing said so, and a worker sat above 500,000 tokens of
 * context for half an hour before a person looked. `assess` is the pure read: given a
 * snapshot of the fleet at one instant, which of five signals has tripped. It parks, kills
 * and nudges nothing — that stays the Warden's job. This only watches and says so.
 *
 * Every reader is injected. A process list, a clock, and a file's mtime are all asked of
 * something passed in, never of the real operating system, which is what lets every
 * specimen here run with no live process on the machine.
 */
import { CLASS_BUDGETS, DEFAULT_CLASS } from './exec.js';
import { contextFor } from './policy.js';

export type LivenessSignal =
  | 'idle' | 'tool-budget' | 'context' | 'stale-session' | 'login-stuck' | 'fleet-unknown';

export interface StuckSignal {
  /** The run name, or `pid:N` for a fleet-process signal. */
  key: string;
  signal: LivenessSignal;
  threshold: number;
  observed: number;
  /** When the condition started, so a reader can tell a fresh trip from a stale one. */
  since: number;
  /** One line saying where to look. */
  hint: string;
}

export interface RunSnapshot {
  run: string;
  className: string;
  /** When the run last produced any journal event. */
  lastEventAt: number;
  /**
   * The tool call in flight, if any, and when it started. `cls` is an exec.ts command
   * class (`install`, `test`, `build`, `script`, `goal`), not the run's own model-policy
   * class; a plain tool call with no command shape behind it defaults to `script`.
   */
  currentTool?: { name: string; startedAt: number; cls?: string };
  /** The run's current context, compared against its class ceiling. */
  context: number;
}

export interface FleetProcess {
  pid: number;
  /** True for a `claude login` process; every other watched process is a worker. */
  isLogin: boolean;
  /** When the login's credentials file was last written, for a login process. */
  credentialsMtime?: number;
  /** When this process's session file was last written, for a worker process. */
  sessionFileMtime?: number;
}

export interface LivenessInput {
  now: number;
  runs: RunSnapshot[];
  /**
   * `{ ok: false, reason }` when the process probe behind this snapshot failed. A failed
   * probe is not the same fact as a verified empty fleet: reading it as `[]` is how a
   * broken sensor gets reported as a clean one.
   */
  fleet: FleetProcess[] | { ok: false; reason: string };
}

export interface LivenessThresholds {
  /** No worker event mid-turn. */
  idleMs: number;
  /** A fleet-account session file that has not been touched. */
  staleSessionMs: number;
  /** A login process still alive after its credentials were written. */
  loginGraceMs: number;
}

export const DEFAULT_THRESHOLDS: LivenessThresholds = {
  idleMs: 120_000,
  staleSessionMs: 5 * 60_000,
  loginGraceMs: 10 * 60_000,
};

/**
 * Every signal that has tripped in this snapshot.
 *
 * Silent one second inside a threshold, tripped one second past it: the boundary is the
 * whole point, since a supervisor watching in real time crosses it exactly once per event
 * and the specimen has to prove that crossing, not just a number comparison.
 */
export function assess(input: LivenessInput, thresholds: LivenessThresholds = DEFAULT_THRESHOLDS): StuckSignal[] {
  const trips: StuckSignal[] = [];

  for (const run of input.runs) {
    const idleFor = input.now - run.lastEventAt;
    if (idleFor >= thresholds.idleMs) {
      trips.push({
        key: run.run, signal: 'idle', threshold: thresholds.idleMs, observed: idleFor,
        since: run.lastEventAt,
        hint: `run ${run.run} has produced no event for ${Math.round(idleFor / 1000)}s; `
          + 'check its lane log for what it is doing',
      });
    }

    if (run.currentTool) {
      const cls = run.currentTool.cls ?? DEFAULT_CLASS;
      const budgetMs = (CLASS_BUDGETS[cls] ?? CLASS_BUDGETS[DEFAULT_CLASS]!).wall * 1000;
      const toolFor = input.now - run.currentTool.startedAt;
      if (toolFor >= budgetMs) {
        trips.push({
          key: run.run, signal: 'tool-budget', threshold: budgetMs, observed: toolFor,
          since: run.currentTool.startedAt,
          hint: `run ${run.run}'s ${run.currentTool.name} call has run `
            + `${Math.round(toolFor / 1000)}s past the ${cls} command class's budget`,
        });
      }
    }

    // classFor throws for a className the loaded policy no longer declares (a stale
    // journal line, a renamed class). This watches; it must never be the thing that
    // brings a long-lived forge up process down over one bad record.
    let ceiling: number | undefined;
    try {
      ceiling = contextFor(run.className);
    } catch {
      ceiling = undefined;
    }
    if (ceiling !== undefined && run.context >= ceiling) {
      trips.push({
        key: run.run, signal: 'context', threshold: ceiling, observed: run.context,
        since: run.lastEventAt,
        hint: `run ${run.run} is at ${run.context} tokens against its ${run.className} `
          + `class ceiling of ${ceiling}`,
      });
    }
  }

  if (!Array.isArray(input.fleet)) {
    // A failed probe and a verified empty fleet must never look the same: the first is a
    // broken sensor, and reading it as zero stale sessions is exactly how one goes
    // unnoticed. This never expires and is never journaled twice for the same reason,
    // the same as every other signal here.
    trips.push({
      key: 'fleet', signal: 'fleet-unknown', threshold: 0, observed: 0, since: input.now,
      hint: `the fleet process probe failed: ${input.fleet.reason}`,
    });
  } else {
    for (const proc of input.fleet) {
      if (proc.isLogin) {
        if (proc.credentialsMtime === undefined) continue;
        const stuckFor = input.now - proc.credentialsMtime;
        if (stuckFor >= thresholds.loginGraceMs) {
          trips.push({
            key: `pid:${proc.pid}`, signal: 'login-stuck', threshold: thresholds.loginGraceMs,
            observed: stuckFor, since: proc.credentialsMtime,
            hint: `login pid ${proc.pid} is still alive `
              + `${Math.round(stuckFor / 60_000)} minutes after its credentials were written`,
          });
        }
        continue;
      }
      if (proc.sessionFileMtime === undefined) continue;
      const staleFor = input.now - proc.sessionFileMtime;
      if (staleFor >= thresholds.staleSessionMs) {
        trips.push({
          key: `pid:${proc.pid}`, signal: 'stale-session', threshold: thresholds.staleSessionMs,
          observed: staleFor, since: proc.sessionFileMtime,
          hint: `fleet pid ${proc.pid}'s session file has not updated in `
            + `${Math.round(staleFor / 60_000)} minutes`,
        });
      }
    }
  }

  return trips;
}

export interface LivenessJournal {
  append(event: Record<string, unknown>): unknown;
}

/**
 * Ticks `assess` against a live snapshot, journals each new trip once and each clear once,
 * and publishes both. Parks, kills and nudges nothing, per the 12:22 decision: this only
 * watches.
 */
export class LivenessSupervisor {
  private readonly open = new Map<string, StuckSignal>();

  constructor(
    private readonly snapshot: () => LivenessInput,
    private readonly journal: LivenessJournal,
    private readonly publish: (event: Record<string, unknown>) => void,
    private readonly thresholds: LivenessThresholds = DEFAULT_THRESHOLDS,
  ) {}

  evaluate(): StuckSignal[] {
    const input = this.snapshot();
    const trips = assess(input, this.thresholds);
    const tripKeys = new Set(trips.map((trip) => `${trip.key}:${trip.signal}`));

    for (const trip of trips) {
      const id = `${trip.key}:${trip.signal}`;
      const existing = this.open.get(id);
      if (!existing) {
        const event = { event: 'liveness.stuck', ...trip };
        this.journal.append(event);
        this.publish(event);
      }
      // `since` marks when the condition first tripped, not when it was last observed.
      // Every signal but fleet-unknown derives it from a stable reader field (lastEventAt,
      // credentialsMtime, sessionFileMtime) that only changes when the underlying thing
      // does, so this is a no-op for them; fleet-unknown has no such field to read (a
      // probe result carries no history of its own) and would otherwise report a fresh
      // "since now" on every 30-second tick for as long as the probe kept failing.
      this.open.set(id, existing ? { ...trip, since: existing.since } : trip);
    }

    for (const [id, trip] of [...this.open.entries()]) {
      if (tripKeys.has(id)) continue;
      this.open.delete(id);
      const event = { event: 'liveness.cleared', key: trip.key, signal: trip.signal };
      this.journal.append(event);
      this.publish(event);
    }

    return this.stuck();
  }

  stuck(): StuckSignal[] {
    return [...this.open.values()];
  }
}
