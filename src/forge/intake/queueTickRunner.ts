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
  private lastCompletionRowAt = 0;
  private lastConsideredCount: number | null = null;
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
      if (this.running) return;
      this.running = true;
      this.options.before?.();
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
    this.options.backoff.onSuccess();

    // A held item writes no row of its own, by design. This is the row that proves the
    // pass happened anyway -- rate limited so ten passes over one held item cannot
    // flood the log, and written at once when the number of items changes, because a
    // changed count is news and a repeated count is not.
    const countChanged = this.lastConsideredCount !== considered;
    if (!countChanged && now - this.lastCompletionRowAt < this.completionEveryMs) {
      this.lastConsideredCount = considered;
      return;
    }
    this.lastConsideredCount = considered;
    this.lastCompletionRowAt = now;
    this.options.journal.append({
      event: 'queue.tick-complete', actor: 'queue', considered, at: now,
    });
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
    // At most one row per run of consecutive identical failures. The backoff still sees
    // every one of them, so its own pause still fires on the third.
    const first = this.failingWith !== message;
    this.failingWith = message;
    if (first) {
      this.options.journal.append({ event: 'queue.tick-error', actor: 'queue', message });
    }
    this.options.backoff.onError(message);
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
