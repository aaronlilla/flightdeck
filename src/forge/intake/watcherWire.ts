/**
 * R-11 part 2: production wiring for `runWatcherIntake` (`watcherIntake.ts`) into
 * `forge up`. Builds the real Jira feed off `FORGE_BACKLOG_PROJECT` and the same
 * credentials `queue-wire.ts#jiraConfigFromEnv` already reads, the on-disk watermark
 * store every other poller in this process shares (`watermarkStore.ts`), and delivers
 * what a poll finds: a `send` rides the owning run's own inbox
 * (`runinbox.ts#RunInbox`), a `close` marks the queue item done. Journals one
 * `watcher.poll` event per poll only when something changed, so an idle board costs one
 * Jira search and no journal growth.
 */
import type { Journal } from '../journal.js';
import type { JiraConfig } from './jira.js';
import { createJiraFeed } from './jira.js';
import type { FakePollFeed, RawPollItem } from './poller.js';
import type { WatermarkStore } from './once.js';
import { runWatcherIntake, type WatcherIntakeResult } from './watcherIntake.js';
import { QUEUE_IN_FLIGHT_STATES } from './queue.js';
import type { QueueStore } from './queueStore.js';
import { RunInbox } from '../runinbox.js';
import { readQueueWidth } from '../console/queue-width.js';

const DEFAULT_WATCHER_POLL_SECONDS = 30;

/** `FORGE_CHAIN_POLL_S`, the same variable the chain reads (`chain-env.ts`) -- shared
 *  by design, per the brief, rather than a second env var naming the same idea -- but
 *  with a 30s default instead of the chain's 300s, since a comment or a status move on
 *  an owned ticket should reach the queue fast. */
export function readWatcherPollSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['FORGE_CHAIN_POLL_S'];
  const parsed = raw ? Number(raw) : DEFAULT_WATCHER_POLL_SECONDS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WATCHER_POLL_SECONDS;
}

/**
 * R-68: two clauses, not the whole board. Clause 1 is Aaron's own open work
 * (`assignee = currentUser()`, not Done, not In Review/QA), which is what `pullJira` (`sync/jira-pull.ts`) also
 * reads with no owned keys. Clause 2, `key in (...)`, is every ticket the queue already
 * owns, regardless of assignee or status -- a lane reassigned to QA at handoff, or moved
 * to Done in Jira, is exactly the case clause 1 alone would stop seeing. Never excludes
 * a Done status: a status move into Done is what `runWatcherIntake` needs to see to
 * close an owned lane.
 */
export function watcherJql(project: string, ownedKeys: readonly string[] = []): string {
  // Clause 1 is NEW work only: Aaron's decision (2026-09-11) that a full re-sync and the
  // watcher never queue a ticket that is already Done or already in review. The status
  // name was read live from BBZ on 2026-09-11 ("In Review/QA", category In Progress).
  // Clause 2 (owned keys) carries no status filter on purpose: an owned lane must stay
  // visible after the QA handoff reassigns it and after a Done move, or it never closes.
  const mine = `project = ${project} AND assignee = currentUser() AND statusCategory != Done AND status != "In Review/QA"`;
  const clause = ownedKeys.length ? `((${mine}) OR key in (${ownedKeys.join(', ')}))` : mine;
  return `${clause} ORDER BY updated ASC`;
}

export function watcherFeed(project: string, config: JiraConfig, ownedKeys: readonly string[] = []): FakePollFeed {
  return createJiraFeed({ ...config, jql: watcherJql(project, ownedKeys) });
}

export interface WatcherTickDeps {
  /** R-68: built fresh every tick from that tick's own owned keys (`store.all()` at the
   *  top of the tick), so a ticket the queue picked up since the last poll is covered by
   *  clause 2 on this very poll rather than the next one. */
  feedFor: (ownedKeys: string[]) => FakePollFeed;
  watermarks: WatermarkStore;
  store: QueueStore;
  journal: Journal;
  now?: () => number;
  /** Test seam only: `RunInbox` writes to disk under `runDir(run)`, which a unit test
   *  has no reason to touch. Defaults to the real inbox. */
  sendTo?: (run: string, text: string) => void;
  /** Item 9, 2026-09-11: the same live width `runQueueTick` gates new admissions with
   *  (`FORGE_QUEUE_MAX_IN_FLIGHT`, `console/queue-width.ts#readQueueWidth`). Read fresh
   *  on every tick, same as the queue's own use of it, so an operator's width change
   *  takes effect on the watcher's very next poll. Defaults to the real reader. */
  maxInFlight?: () => number;
}

const defaultSendTo = (run: string, text: string): void => {
  new RunInbox(run).send(text, 'jira');
};

/** Every ticket key the queue already has an item for, done or not (R-68: `ownedItem`
 *  itself now includes done items, and the watcher's JQL needs the same widened set so a
 *  ticket that just moved to Done keeps being fetched long enough for the poll to see it). */
function ownedKeysOf(store: QueueStore): string[] {
  return [...new Set(store.all().map((item) => item.ticket).filter((ticket): ticket is string => Boolean(ticket)))];
}

/** Item 9, 2026-09-11: how many items the store currently has `planning` or `running` --
 *  the identical count `runQueueTick`'s own `slots` computation subtracts from the width
 *  before admitting a fresh `queued` item. The watcher's own admission of brand-new
 *  tickets is gated against the same number, so a poll that finds many newly-assigned
 *  tickets at once cannot hand the queue more work than it would ever have pulled off
 *  `queued` itself. */
function inFlightCount(store: QueueStore): number {
  return store.all().filter((item) => QUEUE_IN_FLIGHT_STATES.includes(item.state)).length;
}

/** Item 9, 2026-09-11: wraps a real feed so only the first `budget` tickets this store
 *  does not already own pass through `fetchSince` -- everything else (every already-owned
 *  ticket, whose comments/closes still need to reach `runWatcherIntake` uncapped) rides
 *  through untouched, and every held-back brand-new ticket is simply absent from this
 *  poll's page, so the un-advanced watermark picks it back up on the next one exactly the
 *  way a crash-before-persist already does (`runPoll`'s own doc comment). `deferred`
 *  collects the count so the caller can journal it. */
function widthLimitedFeed(feed: FakePollFeed, ownedKeys: ReadonlySet<string>, budget: number, deferred: { count: number }): FakePollFeed {
  return {
    name: feed.name,
    async fetchSince(mark) {
      const page = await feed.fetchSince(mark);
      let remaining = budget;
      const admitted: RawPollItem[] = [];
      const heldBack: RawPollItem[] = [];
      for (const item of page) {
        if (ownedKeys.has(item.id)) {
          admitted.push(item);
          continue;
        }
        if (remaining > 0) {
          admitted.push(item);
          remaining -= 1;
        } else {
          heldBack.push(item);
        }
      }
      if (!heldBack.length) return admitted;
      deferred.count += heldBack.length;
      // Found by code review, 2026-09-11: `runPoll` (`poller.ts`) commits the watermark
      // off `advanceWatermark(mark, page)` -- the MAX `updated` across whatever this call
      // returns, every admitted item included, owned ones too. An owned ticket's own
      // comment or status move (never budgeted, always admitted above) carrying a later
      // `updated` than a held-back new ticket would commit the watermark past that new
      // ticket's own timestamp; `filterNewItems` then reads the new ticket as no longer
      // new on every future poll, since its `updated` never changes again on its own --
      // gone from intake for good, which is worse than the flood this item set out to
      // fix. So nothing in the page this call returns may carry an `updated` later than
      // the oldest held-back ticket's own: an admitted item that would violate that is
      // held back too. It costs that item's send/close this one poll -- the real feed's
      // own `fetchSince` ignores the watermark and returns it again next poll unharmed,
      // and once the watermark is capped below it, `filterNewItems` reads it as fresh
      // again there.
      const floor = Math.min(...heldBack.map((item) => item.updated));
      return admitted.filter((item) => item.updated <= floor);
    },
  };
}

/**
 * One poll cycle: runs `runWatcherIntake`, delivers every send to the owning run's
 * inbox (an item with no `runKey` yet has nothing running to send to, and is skipped),
 * marks every closed item done on the queue store, and journals one `watcher.poll` row
 * with the counts -- only when at least one ticket was added, sent to, or closed.
 */
export async function watcherTick(deps: WatcherTickDeps): Promise<WatcherIntakeResult> {
  const now = deps.now ?? Date.now;
  const sendTo = deps.sendTo ?? defaultSendTo;
  const maxInFlight = deps.maxInFlight ?? readQueueWidth;
  const owned = ownedKeysOf(deps.store);
  const ownedSet = new Set(owned);
  const budget = Math.max(0, maxInFlight() - inFlightCount(deps.store));
  const deferred = { count: 0 };
  const feed = widthLimitedFeed(deps.feedFor(owned), ownedSet, budget, deferred);
  const result = await runWatcherIntake({
    feed, watermarks: deps.watermarks, store: deps.store, now,
  });

  for (const send of result.sends) {
    const item = deps.store.get(send.itemId);
    if (item?.runKey) sendTo(item.runKey, send.text);
  }
  for (const close of result.closed) {
    const at = now();
    deps.store.append({ id: close.itemId, at, state: 'done', reason: close.reason, updatedAt: at });
  }

  if (result.addedTickets.length || result.sends.length || result.closed.length) {
    deps.journal.append({
      event: 'watcher.poll', actor: 'watcher',
      message: `added ${result.addedTickets.length}, sent ${result.sends.length}, closed ${result.closed.length}`,
    } as never);
  }
  if (deferred.count > 0) {
    deps.journal.append({
      event: 'watcher.deferred', actor: 'watcher',
      message: `deferred ${deferred.count}`, deferred: deferred.count,
    } as never);
  }
  return result;
}
