/**
 * R-81: the queue loop's own liveness.
 *
 * A real ticket sat in `planning` for thirty-three minutes on 2026-09-11 and nothing
 * anywhere said so. The console kept serving, kept writing session records, and reported
 * itself healthy. Three readers concluded three different wrong causes before the real
 * one, because a held item deliberately writes no record per tick (`queue.ts`'s
 * `if (item.reason === reason) return item;`) and so a quiet loop and a dead loop look
 * identical from outside.
 *
 * This module is the timer callback `cli.ts` schedules -- not a wrapper beside it. Three
 * things it guarantees that a bare `setInterval(() => { void tick(); })` does not:
 *
 * 1. No error escapes, synchronous or asynchronous. A throw out of the callback body
 *    (the backoff's own check, the Slack read, `runQueueTick` throwing before it ever
 *    returns a promise) reaches Node as an uncaught exception; the failure is recorded
 *    with its message instead, and the next interval still fires.
 * 2. The time of the last completed pass is held in memory and served on the state read,
 *    so "overdue" is a question anybody can answer without replaying the journal.
 * 3. A pass over a held item still proves the loop ran -- at most one completion row a
 *    minute, or immediately when the number of items considered changes.
 *
 * It deliberately does NOT change what the tick decides. Every hop, every transition and
 * every refusal still belongs to `runQueueTick`.
 */

export interface QueueTickRunnerJournal {
  append(row: Record<string, unknown>): unknown;
}

/** The slice of `QueueTickBackoff` this runner uses. */
export interface QueueTickRunnerBackoff {
  dueToRun(): boolean;
  onSuccess(): void;
  onError(message: string): void;
}

export interface QueueTickRunnerOptions<T> {
  /** The real work of one pass. In `cli.ts` this is `runQueueTick` bound to its deps. */
  tick: (items: T[]) => Promise<unknown>;
  /** Read fresh every pass, never captured: the store changes under the timer. */
  items: () => T[];
  journal: QueueTickRunnerJournal;
  backoff: QueueTickRunnerBackoff;
  /** How often the timer fires. Three of these with no completed pass reads as overdue. */
  intervalMs: number;
  /** Runs before the pass, inside the same guard (the Slack reply read in `cli.ts`).
   *  A throw here is recorded like any other failure rather than killing the timer. */
  before?: () => void;
  now?: () => number;
  /** Quiet ceiling on the completion row. */
  completionEveryMs?: number;
  /** How many intervals may pass with no completed pass before the loop reads overdue. */
  overdueIntervals?: number;
}

export type QueueLoopOutcome = 'ok' | 'failed';

export interface QueueLoopStatus {
  /** Whether the process answering this read is the one running the queue timer. False
   *  means "ask elsewhere", which is a different answer from a loop that has stopped --
   *  and telling those two apart was the whole point of the field. */
  ticking: boolean;
  /** Plain English, no identifier in it: safe to put straight on a screen. */
  sentence: string;
  /** Epoch millis of the last pass that finished CLEAN. Null before the first.
   *  A failed pass never stamps this: a tick throwing every interval is a stopped loop
   *  wearing a heartbeat, and `overdue` exists to say so. */
  lastCompletedAt: number | null;
  lastOutcome: QueueLoopOutcome | null;
  /** The message of the last failure, when the last pass failed. Kept out of `sentence`
   *  because an error message can carry a ticket key, a path or a pid. */
  lastError: string | null;
  /** Epoch millis of the last pass that threw. Null when none has. */
  lastFailedAt: number | null;
  /** Whether the backoff is dripping rather than running every interval. Tracked apart
   *  from the outcome so a pause cannot overwrite the fact that passes are failing. */
  paused: boolean;
  overdue: boolean;
  /** How long since the last completed pass (or since start), in seconds. */
  sinceLastCompletedSeconds: number;
  intervalSeconds: number;
  observed_at: number;
}

/** "15 seconds", "2 minutes", "1 hour 5 minutes" -- enough to name a gap, no more. */
export function saidGap(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest ? `${hourPart} ${rest} minute${rest === 1 ? '' : 's'}` : hourPart;
}

export class QueueTickRunner<T> {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly completionEveryMs: number;
  private readonly overdueIntervals: number;

  private lastCompletedAt: number | null = null;
  private lastOutcome: QueueLoopOutcome | null = null;
  private lastError: string | null = null;
  private lastFailedAt: number | null = null;
  private paused = false;
  /** The message of the failure currently running, so a run of identical failures is
   *  recorded once rather than every fifteen seconds all night. */
  private failingWith: string | null = null;
  /** When the last `queue.tick-error` row was written, 0 while no run of failures is
   *  under way (null). Reset by a clean pass so a new run always records at once. */
  private lastErrorRowAt: number | null = null;
  /** Null until the first row. A zero sentinel is wrong here: a clock that starts at
   *  zero would read every tick as 'no row yet'. */
  private lastCompletionRowAt: number | null = null;
  private lastConsideredCount: number | null = null;
  /** Whether the considered count has moved since the last row was written. Carried on
   *  the next row rather than forcing one out of turn. */
  private countMovedSinceRow = false;
  /** One pass at a time. Two overlapping passes over the same store double every hop. */
  private running = false;
  private current: Promise<void> | null = null;

  constructor(private readonly options: QueueTickRunnerOptions<T>) {
    this.now = options.now ?? Date.now;
    this.completionEveryMs = options.completionEveryMs ?? 60_000;
    this.overdueIntervals = options.overdueIntervals ?? 3;
    this.startedAt = this.now();
  }

  /** The timer callback itself. Never throws and never returns a rejected promise:
   *  `setInterval(runner.tick)` is the whole of the wiring in `cli.ts`. */
  readonly tick = (): void => {
    try {
      if (!this.options.backoff.dueToRun()) {
        // The backoff is dripping rather than running every interval. Recorded beside
        // the outcome, never over it: a pause is a consequence of failures, and
        // overwriting 'failed' with it would dress the failure up as housekeeping.
        this.paused = true;
        return;
      }
      this.paused = false;
      // Before the one-pass-at-a-time guard, deliberately. `cli.ts` passes the reply read
      // here, and a queue pass that plans a ticket and runs a council routinely outlasts
      // the fifteen second interval -- putting this behind the guard silently stopped
      // reading replies for the whole of any real pass (/code-review high, 2026-09-11).
      // It carries its own in-flight flag.
      this.options.before?.();
      if (this.running) return;
      this.running = true;
      const items = this.options.items();
      this.current = this.options.tick(items)
        .then(() => { this.onCompleted(items.length); })
        .catch((error: unknown) => { this.onFailed(error); })
        .finally(() => { this.running = false; });
    } catch (error: unknown) {
      // A synchronous throw out of the body above -- the backoff's own check, the
      // Slack read, the store read, or `tick` throwing before it returns a promise.
      // Without this it reaches Node as an uncaught exception and the loop is gone.
      this.running = false;
      this.onFailed(error);
    }
  };

  /**
   * Write one row, and never let the writing of it change what happened. A journal append
   * that throws (a full disk, a handle closed under a shutdown) used to propagate out of
   * `onCompleted`, land in the promise's own `.catch`, and report a clean pass as a tick
   * failure -- a record that swallows itself and takes the truth with it. Found by
   * `/code-review high`, 2026-09-11.
   */
  private record(row: Record<string, unknown>): void {
    try {
      this.options.journal.append(row);
    } catch {
      // Nothing durable can be written right now. The in-memory status this class serves
      // on `/state` is the sensor that is left, and it is already correct.
    }
  }

  /** Same reasoning for the backoff, which journals its own pause row. */
  private tellBackoff(run: () => void): void {
    try {
      run();
    } catch {
      // The backoff's own bookkeeping is best effort; the pass itself already happened.
    }
  }

  /** Resolves once the pass in flight, if any, has finished. The shutdown path and any
   *  caller that must observe a pass it started await this rather than guessing at a
   *  timer. */
  whenIdle(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  status(): QueueLoopStatus {
    const now = this.now();
    const since = now - (this.lastCompletedAt ?? this.startedAt);
    const overdue = since > this.options.intervalMs * this.overdueIntervals;
    return {
      ticking: true,
      sentence: this.sentence(since, overdue),
      lastCompletedAt: this.lastCompletedAt,
      lastOutcome: this.lastOutcome,
      lastError: this.lastError,
      lastFailedAt: this.lastFailedAt,
      paused: this.paused,
      overdue,
      sinceLastCompletedSeconds: Math.round(since / 1000),
      intervalSeconds: Math.round(this.options.intervalMs / 1000),
      observed_at: now,
    };
  }

  private sentence(sinceMs: number, overdue: boolean): string {
    const gap = saidGap(sinceMs);
    const every = saidGap(this.options.intervalMs);
    if (overdue) {
      const head = this.lastCompletedAt === null
        ? `The queue loop has not finished a pass since it started ${gap} ago`
        : `The queue loop has not finished a pass in ${gap}`;
      const tail = this.lastOutcome === 'failed'
        ? `, and every pass since has failed${this.paused ? ', so it is backing off' : ''}`
        : `, and it is meant to run every ${every}`;
      return `${head}${tail}.`;
    }
    if (this.lastCompletedAt === null) {
      return `The queue loop started ${gap} ago and runs every ${every}.`;
    }
    if (this.lastOutcome === 'failed') {
      return `The queue loop last finished a clean pass ${gap} ago, and its latest pass failed.`;
    }
    return `The queue loop finished a pass ${gap} ago.`;
  }

  private onCompleted(considered: number): void {
    const now = this.now();
    this.lastCompletedAt = now;
    this.lastOutcome = 'ok';
    this.lastError = null;
    this.failingWith = null;
    this.lastErrorRowAt = null;
    this.tellBackoff(() => { this.options.backoff.onSuccess(); });

    // A held item writes no row of its own, by design. This is the row that proves the
    // pass happened anyway. The ceiling is one row a minute and it binds unconditionally:
    // exempting a changed count meant an ordinary busy queue, whose count moves every
    // pass, wrote a row per tick forever -- the flood this ceiling exists to stop (two
    // independent reviews, 2026-09-11). The row carries the count and whether it moved
    // since the last row, so a change is still recorded, one minute later at worst.
    const countChanged = this.lastConsideredCount !== considered;
    this.lastConsideredCount = considered;
    if (countChanged) this.countMovedSinceRow = true;
    if (this.lastCompletionRowAt !== null && now - this.lastCompletionRowAt < this.completionEveryMs) return;
    const changed = this.countMovedSinceRow;
    this.countMovedSinceRow = false;
    this.lastCompletionRowAt = now;
    this.record({ event: 'queue.tick-complete', actor: 'queue', considered, changed, at: now });
  }

  private onFailed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const now = this.now();
    // Deliberately NOT `lastCompletedAt`. A tick that throws every interval would
    // otherwise keep `overdue` false forever while doing no work at all, which is the
    // heartbeat-reporting-healthy failure this whole module exists to remove.
    this.lastFailedAt = now;
    this.lastOutcome = 'failed';
    this.lastError = message;
    // At most one row per run of consecutive identical failures -- and, since an error
    // carrying a retry count, a port or a path is a different string every tick and
    // defeated that outright (/critique and /code-review, 2026-09-11), never more than
    // one row a minute whatever the message says. The backoff still sees every failure,
    // so its own pause still fires on the third.
    const changed = this.failingWith !== message;
    this.failingWith = message;
    const lastRowAt = this.lastErrorRowAt;
    if (changed && (lastRowAt === null || now - lastRowAt >= this.completionEveryMs)) {
      this.lastErrorRowAt = now;
      this.record({ event: 'queue.tick-error', actor: 'queue', message });
    }
    this.tellBackoff(() => { this.options.backoff.onError(message); });
  }
}

/**
 * What `/state` says on a process that boots the server but does not hold the queue lock.
 * Without this the field is `null` there, which reads exactly like a process that should
 * be ticking and is not -- found by `/critique`, 2026-09-11.
 */
export function notTickingHere(intervalMs: number): QueueLoopStatus {
  return {
    ticking: false,
    sentence: 'This process is not running the queue loop; another process holds the queue lock.',
    lastCompletedAt: null,
    lastOutcome: null,
    lastError: null,
    lastFailedAt: null,
    paused: false,
    overdue: false,
    sinceLastCompletedSeconds: 0,
    intervalSeconds: Math.round(intervalMs / 1000),
    observed_at: Date.now(),
  };
}
