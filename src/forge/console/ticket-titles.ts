/**
 * What a queued ticket is called, before anybody has planned it.
 *
 * A queue card's title came off the brief written for that item, and a brief is not
 * written until the item starts. Ingesting a board therefore produced a column of
 * `Title not read yet` beside bare keys -- nineteen of them on 2026-09-13, every one of
 * them a ticket whose summary the console could already read on demand for a hover.
 *
 * `GET /queue` answers a five-second poll and cannot afford a network read per card, so
 * nothing here is awaited by a request. `want` says which keys are on screen and returns
 * at once; `get` answers from what has been read so far, and answers null until the
 * first read lands. The card is briefly unnamed rather than the board briefly frozen.
 */
import type { JiraIssueRead } from '../intake/jira.js';

export interface TicketTitlesOptions {
  read: (key: string) => Promise<JiraIssueRead | null>;
  /** How long a key that could not be read waits before it is asked about again. A key
   *  with no answer is the normal case for a board the credentials only partly cover, and
   *  without this every poll would re-ask every one of them -- a call per card per five
   *  seconds against somebody else's Jira. Default: five minutes. */
  retryAfterMs?: number;
  now?: () => number;
}

const DEFAULT_RETRY_MS = 5 * 60 * 1000;

export class TicketTitles {
  private readonly titles = new Map<string, string>();

  /** Keys asked about and answered with nothing, against the time they were asked. */
  private readonly missed = new Map<string, number>();

  private readonly inFlight = new Map<string, Promise<void>>();

  private readonly opts: Required<TicketTitlesOptions>;

  constructor(options: TicketTitlesOptions) {
    this.opts = {
      read: options.read,
      retryAfterMs: options.retryAfterMs ?? DEFAULT_RETRY_MS,
      now: options.now ?? (() => Date.now()),
    };
  }

  /** The summary read for this key, or null while nothing has been read for it. Null is
   *  never "this ticket has no title": it is "the board has not read one yet", which is
   *  the caller's own fallback to make. */
  get(key: string): string | null {
    return this.titles.get(key) ?? null;
  }

  /** Start reading whatever is not known yet. Returns immediately; nothing a request
   *  serves ever waits on this. */
  want(keys: Iterable<string>): void {
    for (const key of new Set(keys)) {
      if (!key || this.titles.has(key) || this.inFlight.has(key)) continue;
      const missedAt = this.missed.get(key);
      if (missedAt !== undefined && this.opts.now() - missedAt < this.opts.retryAfterMs) continue;
      this.inFlight.set(key, this.readOne(key));
    }
  }

  /** Resolves once every read started so far has finished. For a test, and for a caller
   *  that wants the board named before it renders once -- never on a poll path. */
  async settled(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  private async readOne(key: string): Promise<void> {
    try {
      const issue = await this.opts.read(key);
      const summary = issue?.summary?.trim();
      if (summary) this.titles.set(key, summary);
      else this.missed.set(key, this.opts.now());
    } catch {
      // A reader that throws is a reader that will probably throw again in a moment, so
      // it waits the same interval an empty answer does rather than retrying per poll.
      this.missed.set(key, this.opts.now());
    } finally {
      this.inFlight.delete(key);
    }
  }
}
