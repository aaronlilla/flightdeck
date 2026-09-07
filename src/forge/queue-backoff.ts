/**
 * B.1: the queue tick's own backoff.
 *
 * A queue worker tick that throws every 15 seconds all night is not a signal, it is a log
 * flood: the same misconfigured Jira token or unreachable repo produces the same
 * `queue.tick-error` message forever, and nothing about repeating it every 15 seconds
 * teaches Aaron anything the first three did not. Three of the same message in a row backs
 * the tick off to a 10 minute drip and says so once, in the journal, as `queue.paused`. Any
 * change in the error's own text, including a run that finally succeeds, resumes the normal
 * cadence at once.
 *
 * This is the decision only. `cli.ts`'s `up` case is the one caller: it asks `dueToRun`
 * before invoking `runQueueTick`, and reports the outcome back with `onError`/`onSuccess`.
 */
export interface QueueTickBackoffJournal {
  append(event: Record<string, unknown>): unknown;
}

export interface QueueTickBackoffOptions {
  /** Consecutive identical errors before the tick backs off. */
  threshold?: number;
  /** How long the tick drips while paused. */
  dripMs?: number;
  now?: () => number;
}

export class QueueTickBackoff {
  private readonly threshold: number;
  private readonly dripMs: number;
  private readonly now: () => number;

  private consecutive = 0;
  private lastMessage: string | undefined;
  private paused = false;
  private pausedAt = 0;

  constructor(
    private readonly journal: QueueTickBackoffJournal,
    options: QueueTickBackoffOptions = {},
  ) {
    this.threshold = options.threshold ?? 3;
    this.dripMs = options.dripMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Whether the tick should actually run right now. While paused, only every `dripMs`. */
  dueToRun(): boolean {
    if (!this.paused) return true;
    return this.now() - this.pausedAt >= this.dripMs;
  }

  /**
   * Record a tick error. Three of the same message in a row pauses the cadence; a message
   * that differs from the last one resumes it immediately, on the theory that a changed
   * error is a changed situation, worth watching at full speed again rather than through
   * the same 10 minute drip that was tuned for the error it has already stopped being.
   */
  onError(message: string): void {
    if (message === this.lastMessage) {
      this.consecutive += 1;
    } else {
      this.consecutive = 1;
      this.lastMessage = message;
      this.paused = false;
    }

    if (this.paused) {
      // Still on the drip, still the same error: push the next attempt out another
      // full interval rather than retrying every 15 seconds while paused.
      this.pausedAt = this.now();
      return;
    }

    if (this.consecutive >= this.threshold) {
      this.paused = true;
      this.pausedAt = this.now();
      this.journal.append({
        event: 'queue.paused', actor: 'queue', reason: message,
        dripMs: this.dripMs, consecutive: this.consecutive,
      });
    }
  }

  /** A tick that ran clean. Clears the streak and lifts a pause outright. */
  onSuccess(): void {
    this.consecutive = 0;
    this.lastMessage = undefined;
    this.paused = false;
  }
}
