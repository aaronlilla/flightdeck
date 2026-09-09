/**
 * R-11: the Jira watcher's testable core. One poll cycle that feeds the queue
 * directly, using the same `runIntakeOnce` primitive `chain-wire.ts#chainIntake`
 * already runs, but calling `addTicketItem` on the `QueueStore` for every new packet
 * instead of planning a chain brief. This is the pure half, mirroring the split
 * `chain.ts` keeps from `chain-wire.ts`: no network, no `~/.forge` read, no
 * `process.env` read. Every feed, watermark store and queue store is handed in, so a
 * specimen never needs any of it. `chain-wire.ts#queueIntake` is the wired half that
 * builds the real feed and the real `QueueStore` and calls this.
 *
 * De-dupe is against the queue itself, not the packet. `runIntakeOnce` is called with
 * no persisted `PacketStore` (a fresh one every call, same as `chainIntake`), so the
 * watermark alone decides whether an item is new to this poll. A ticket the watermark
 * reports as newly updated but that the queue already owns in a non-done state (it
 * moved because of a comment, or a re-triaged label, not because it just entered the
 * backlog) is skipped here instead of re-queued. Turning that skip into "comments
 * become sends" and "Done closes the lane" (goal brief items 3 and 4) is not built yet
 * (2026-09-09 handoff).
 */
import type { QueueStore } from './queueStore.js';
import { addTicketItem } from './queue.js';
import type { FakePollFeed } from './poller.js';
import { runIntakeOnce, type IntakeOnceEvent, type WatermarkStore } from './once.js';

export interface QueueIntakeResult {
  /** Ticket keys added to the queue this cycle. */
  added: string[];
  /** Ticket keys the watermark reported as new or updated, but that the queue already
   *  owns in a non-done state, so they were skipped instead of re-queued. */
  skippedOwned: string[];
}

/** A ticket is "owned" by the queue when any item for it is not `done`. Covers
 *  queued/planning/running/parked/review, not only the narrower
 *  `QUEUE_IN_FLIGHT_STATES` (`queue.ts`), matching the goal brief's own wording:
 *  "already on the queue in any non-done state". */
function ownsTicket(store: QueueStore, ticket: string): boolean {
  return store.all().some((item) => item.ticket === ticket && item.state !== 'done');
}

export async function runQueueIntakeOnce(
  feeds: FakePollFeed[],
  watermarks: WatermarkStore,
  store: QueueStore,
  emit: (event: IntakeOnceEvent) => void,
  now: () => number = Date.now,
): Promise<QueueIntakeResult> {
  const result = await runIntakeOnce(feeds, watermarks, emit);

  const added: string[] = [];
  const skippedOwned: string[] = [];
  for (const packet of result.writtenPackets) {
    if (ownsTicket(store, packet.ticket)) {
      skippedOwned.push(packet.ticket);
      continue;
    }
    addTicketItem(store, packet.ticket, now());
    added.push(packet.ticket);
  }
  return { added, skippedOwned };
}
