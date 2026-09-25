/**
 * R-68 item 1: the Jira watcher's runtime on/off switch (`~/.forge/console/watcher.json`,
 * `watcherStatePath()`) and the engine that owns its interval. Before this file the
 * watcher could only start at `forge up`'s own boot, from `FORGE_BACKLOG_PROJECT` -- this
 * is what lets `POST /watcher/on` start it later, from the console, with no restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { FeedPassStatus, WatcherStatus } from '../../shared/sync-contract.js';
import type { JiraConfig } from '../intake/jira.js';
import type { FeedActivityResult } from '../intake/jiraFeed.js';
import type { TicketPoller, TicketPollResult } from './watcher-thread-host.js';
import type { WatermarkStore } from '../intake/once.js';
import type { QueueStore } from '../intake/queueStore.js';
import { feedProjects, readWatcherPollSeconds, watcherFeed, watcherJql, watcherTick } from '../intake/watcherWire.js';
import type { Journal } from '../journal.js';
import { watcherStatePath } from '../paths.js';

export { watcherJql };

export interface WatcherFileState {
  on: boolean;
  project: string | null;
}

const BLANK_STATE: WatcherFileState = { on: false, project: null };

export function readWatcherState(path: string = watcherStatePath()): WatcherFileState {
  if (!existsSync(path)) return { ...BLANK_STATE };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<WatcherFileState>;
    return { on: data.on === true, project: data.project ?? null };
  } catch {
    return { ...BLANK_STATE };
  }
}

export function writeWatcherState(state: WatcherFileState, path: string = watcherStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state), 'utf8');
}

/**
 * `cli.ts`'s boot decision, pulled out so it is testable without spinning up `forge up`.
 * Once `watcher.json` exists at all, its own `on` flag is authoritative -- an explicit
 * `POST /watcher/off` must stay off across a restart even while `FORGE_BACKLOG_PROJECT`
 * is still set in the environment (the ordinary case: nothing unsets that env var when a
 * person flips the switch from the console). Only a machine that has never written the
 * file falls back to the old "env var is set" rule, so a fresh install with no watcher
 * history keeps its prior boot-only behavior.
 */
export function shouldAutoStartWatcher(
  stateFileExists: boolean, state: WatcherFileState, envProject: string | undefined,
): boolean {
  return stateFileExists ? state.on : Boolean(envProject);
}

/** R-101: the feed's second half, run beside every watcher poll. `reset` marks "now" as
 *  where the feed starts, called when a person turns it on (never on a restart, so a
 *  comment written while the console was down is still handled). */
export interface JiraFeedActivity {
  run(project: string): Promise<FeedActivityResult>;
  reset(now: number): void;
}

export interface JiraWatcherDeps {
  jiraConfig: () => JiraConfig | undefined;
  watermarks: WatermarkStore;
  store: QueueStore;
  journal: Journal;
  pollSeconds?: number;
  now?: () => number;
  activity?: JiraFeedActivity;
  holdLabels?: readonly string[];
  /** R-101: where the ticket poll runs. Absent polls on this thread (every test);
   *  `forge up` hands in a `ThreadTicketPoller` so a stalled console cannot delay it. */
  poller?: TicketPoller;
  /** R-101: when the feed's self-test ends, or null while it is off. */
  selfTestUntil?: () => number | null;
  /** R-101: how often the comment pass runs, in seconds, independent of the ticket poll
   *  (default 2). Measured live: tied to the 5 s poll result, a burst of comments waited
   *  6 to 8 s before the pass began. */
  feedSeconds?: number;
}

/**
 * Owns the interval `cli.ts`'s boot block used to own inline. `start`/`stop` are the
 * production side of `POST /watcher/on|off`; `status()` is what `/state.watcher` and
 * `GET /sync` both read. One poll runs immediately on `start`, same as the old inline
 * `setInterval` callback firing on its first real tick -- a click on "watcher on"
 * shouldn't wait a full `pollSeconds` for its first result.
 */
export class JiraWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;

  private project: string | null = null;

  private readonly pollSeconds: number;

  private readonly now: () => number;

  private lastPollAt: number | undefined;

  private lastCount: number | undefined;

  private lastError: string | undefined;

  private activityError: string | undefined;

  /** One poll and one feed pass at a time each: at a five second interval, a slow Jira
   *  search or a reasoner call routinely outlasts the tick, and two overlapping passes
   *  would read the same watermark and ledger. */
  private polling = false;

  private feeding: Promise<void> | null = null;

  /** The comment feed's last pass, for `status().feed`. */
  private lastFeed: FeedPassStatus | undefined;

  private ticketsAdded: (() => void) | undefined;

  private feedTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: JiraWatcherDeps) {
    this.pollSeconds = deps.pollSeconds ?? readWatcherPollSeconds();
    this.now = deps.now ?? Date.now;
  }

  /** R-101: called after a poll queues at least one ticket, so the queue plans it now
   *  rather than on its own next tick. `cli.ts` hands in the queue runner's tick. */
  onTicketsAdded(fn: () => void): void {
    this.ticketsAdded = fn;
  }

  private async pollOnce(project: string): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollTickets(project);
    } finally {
      this.polling = false;
    }
    this.startActivity(project);
  }

  private async pollTickets(project: string): Promise<void> {
    const config = this.deps.jiraConfig();
    if (!config) {
      this.lastError = 'no Jira credentials';
      return;
    }
    try {
      const result = await watcherTick({
        feedFor: (ownedKeys) => watcherFeed(feedProjects(project), config, ownedKeys),
        watermarks: this.deps.watermarks,
        store: this.deps.store,
        journal: this.deps.journal,
        now: this.now,
        ...(this.deps.holdLabels ? { holdLabels: this.deps.holdLabels } : {}),
      });
      this.lastPollAt = this.now();
      this.lastCount = result.addedTickets.length + result.sends.length + result.closed.length;
      this.lastError = undefined;
      if (result.addedTickets.length && this.ticketsAdded) {
        try { this.ticketsAdded(); } catch { /* the queue's own tick records its failures */ }
      }
    } catch (error) {
      this.lastPollAt = this.now();
      this.lastError = error instanceof Error ? error.message : String(error);
      this.deps.journal.append({
        event: 'watcher.tick-error', actor: 'watcher', message: this.lastError,
      } as never);
    }
  }

  private startActivity(project: string): void {
    const activity = this.deps.activity;
    if (!activity || this.feeding || !this.deps.jiraConfig()) return;
    this.feeding = activity.run(project)
      .then((result) => {
        this.activityError = undefined;
        this.lastFeed = {
          lastPassAt: this.now(),
          considered: result.considered,
          replied: result.replied.length,
          deferred: result.deferred.length,
          ignored: result.ignored.length,
          claimed: result.claimed.length,
          sent: result.sent.length,
          failed: result.failed.length,
        };
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.lastFeed = {
          ...(this.lastFeed ?? { considered: 0, replied: 0, deferred: 0, ignored: 0, claimed: 0, sent: 0, failed: 0 }),
          lastPassAt: this.now(),
          lastError: message,
        };
        if (message !== this.activityError) {
          this.deps.journal.append({ event: 'feed.tick-error', actor: 'feed', message } as never);
        }
        this.activityError = message;
      })
      .finally(() => { this.feeding = null; });
  }

  /** Resolves once any feed pass in flight has finished. Tests and shutdown only. */
  async settled(): Promise<void> {
    await this.feeding;
  }

  /** Starts polling `project`. Awaiting it means the first poll has already happened;
   *  production callers (`cli.ts`, `POST /watcher/on`) can also fire-and-forget.
   *  `fresh` (a person turning the feed on) starts the feed's comment handling from now. */
  async start(project: string, options: { fresh?: boolean } = {}): Promise<void> {
    this.stop();
    this.project = project;
    if (options.fresh) this.deps.activity?.reset(this.now());
    if (this.deps.activity) {
      // The comment pass keeps its own short cadence; `startActivity` skips a pass while
      // the previous one is still running, so this never stacks passes.
      this.feedTimer = setInterval(() => { this.startActivity(project); }, (this.deps.feedSeconds ?? 2) * 1000);
      (this.feedTimer as unknown as { unref?: () => void }).unref?.();
    }
    if (this.deps.poller) {
      // The thread polls at once and on its own interval; nothing here waits on it.
      this.deps.poller.start(project, (result) => { this.onPolled(project, result); });
      return;
    }
    await this.pollOnce(project);
    this.timer = setInterval(() => { void this.pollOnce(project); }, this.pollSeconds * 1000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** One poll result from the thread: the same bookkeeping `pollTickets` does in-process,
   *  then the queue nudge and the comment pass. */
  private onPolled(project: string, result: TicketPollResult): void {
    this.lastPollAt = result.at;
    this.lastCount = result.count;
    this.lastError = result.error;
    if (result.addedTickets.length && this.ticketsAdded) {
      try { this.ticketsAdded(); } catch { /* the queue's own tick records its failures */ }
    }
    this.startActivity(project);
  }

  stop(): void {
    this.deps.poller?.stop();
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  status(): WatcherStatus {
    return {
      on: this.timer !== undefined || this.deps.poller?.running === true,
      project: this.project,
      pollSeconds: this.pollSeconds,
      ...(this.lastPollAt !== undefined
        ? { lastPollAt: this.lastPollAt, nextPollAt: this.lastPollAt + this.pollSeconds * 1000 }
        : {}),
      ...(this.lastCount !== undefined ? { lastCount: this.lastCount } : {}),
      ...((() => { const until = this.deps.selfTestUntil?.() ?? null; return until !== null ? { selfTestUntil: until } : {}; })()),
      ...((this.lastError ?? this.activityError) !== undefined ? { lastError: this.lastError ?? this.activityError } : {}),
      ...(this.lastFeed ? { feed: this.lastFeed } : {}),
    };
  }
}
