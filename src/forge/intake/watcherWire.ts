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
import type { FakePollFeed } from './poller.js';
import type { WatermarkStore } from './once.js';
import { runWatcherIntake, type WatcherIntakeResult } from './watcherIntake.js';
import type { QueueStore } from './queueStore.js';
import { RunInbox } from '../runinbox.js';

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

/** The watcher's own feed: every issue in the project, newest first filter aside --
 *  unlike `queue-wire.ts#buildBacklogJql` this deliberately does not exclude a Done
 *  status, since a status move into Done is exactly what `runWatcherIntake` needs to see
 *  to close an owned lane. */
export function watcherJql(project: string): string {
  return `project = ${project} ORDER BY updated ASC`;
}

export function watcherFeed(project: string, config: JiraConfig): FakePollFeed {
  return createJiraFeed({ ...config, jql: watcherJql(project) });
}

export interface WatcherTickDeps {
  feed: FakePollFeed;
  watermarks: WatermarkStore;
  store: QueueStore;
  journal: Journal;
  now?: () => number;
  /** Test seam only: `RunInbox` writes to disk under `runDir(run)`, which a unit test
   *  has no reason to touch. Defaults to the real inbox. */
  sendTo?: (run: string, text: string) => void;
}

const defaultSendTo = (run: string, text: string): void => {
  new RunInbox(run).send(text, 'jira');
};

/**
 * One poll cycle: runs `runWatcherIntake`, delivers every send to the owning run's
 * inbox (an item with no `runKey` yet has nothing running to send to, and is skipped),
 * marks every closed item done on the queue store, and journals one `watcher.poll` row
 * with the counts -- only when at least one ticket was added, sent to, or closed.
 */
export async function watcherTick(deps: WatcherTickDeps): Promise<WatcherIntakeResult> {
  const now = deps.now ?? Date.now;
  const sendTo = deps.sendTo ?? defaultSendTo;
  const result = await runWatcherIntake({
    feed: deps.feed, watermarks: deps.watermarks, store: deps.store, now,
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
  return result;
}
