/**
 * R-11: the Jira watcher bridge. It polls the watcher's own feed via `runIntakeOnce` and,
 * for every new packet, either adds a fresh queue item (a ticket the queue does not yet
 * own) or acts on the ticket it already owns: a status move into a Done category retires
 * the lane, and a fresh comment on a lane in a sendable state becomes a `/send`. Nothing
 * here touches the network or the queue's disk directly; `deps.store`/`deps.feed`/
 * `deps.watermarks` are the same seams `queue.ts`/`once.ts`/`poller.ts` already define.
 */
import type { IntakeOnceEvent, WatermarkStore } from './once.js';
import { runIntakeOnce } from './once.js';
import type { FakePollFeed, PollItemDetail } from './poller.js';
import { addTicketItem } from './queue.js';
import type { QueueStore } from './queueStore.js';

export interface WatcherSend {
  itemId: string;
  ticket: string;
  text: string;
}

export interface WatcherClose {
  itemId: string;
  ticket: string;
  reason: string;
}

export interface WatcherIntakeResult {
  addedTickets: string[];
  sends: WatcherSend[];
  closed: WatcherClose[];
}

export interface WatcherIntakeDeps {
  feed: FakePollFeed;
  watermarks: WatermarkStore;
  store: QueueStore;
  emit?: (event: IntakeOnceEvent) => void;
  now?: () => number;
}

/** A lane the watcher may drop a comment into as a `/send`: an item mid-flight or
 *  already parked for a person, never one still `queued` (nobody has picked it up yet)
 *  or already `done`/`review` (nothing left running to send an instruction to). */
const SEND_STATES = new Set(['running', 'parked', 'review']);

/** R-68: includes a `done` item on purpose -- a ticket the queue has already handled
 *  once must never be re-added as a fresh queue item just because Jira still lists it. */
function ownedItem(store: QueueStore, ticket: string) {
  return store.all().find((item) => item.ticket === ticket);
}

/**
 * One poll cycle over the watcher's feed. New tickets are added to the queue; a ticket
 * the queue already owns is never re-added. Its newest comment becomes a send when the
 * lane is in a sendable state, and a Done status category closes the lane instead.
 */
export async function runWatcherIntake(deps: WatcherIntakeDeps): Promise<WatcherIntakeResult> {
  const now = deps.now ?? Date.now;
  const details = new Map<string, PollItemDetail | undefined>();
  const emit = (event: IntakeOnceEvent) => {
    if (event['event'] === 'source.observed') {
      details.set(String(event['sourceId']), event['detail'] as PollItemDetail | undefined);
    }
    deps.emit?.(event);
  };
  const result = await runIntakeOnce([deps.feed], deps.watermarks, emit);

  const addedTickets: string[] = [];
  const sends: WatcherSend[] = [];
  const closed: WatcherClose[] = [];

  for (const packet of result.writtenPackets) {
    const ticket = packet.ticket;
    const detail = details.get(ticket);
    const owned = ownedItem(deps.store, ticket);

    if (!owned) {
      addTicketItem(deps.store, ticket, now());
      addedTickets.push(ticket);
      continue;
    }
    if (detail?.statusCategory?.toLowerCase() === 'done') {
      closed.push({ itemId: owned.id, ticket, reason: 'closed in Jira' });
      continue;
    }
    if (SEND_STATES.has(owned.state) && detail?.latestComment) {
      const { author, body } = detail.latestComment;
      sends.push({ itemId: owned.id, ticket, text: `${author}: ${body}` });
    }
  }
  return { addedTickets, sends, closed };
}
