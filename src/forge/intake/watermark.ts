/**
 * Watermark semantics for a poll source (requirement 1: pagination, equal timestamps, a
 * durable commit after a full scan — roadmap:113).
 *
 * `advanceWatermark` is pure and takes a whole page (or a whole scan's worth of items)
 * at once; there is no partial-apply entry point. That is what makes "a crash mid-scan
 * leaves the prior watermark in force" true by construction rather than by discipline:
 * the caller that owns durable storage (Governor's own store, not this stream) only
 * calls this once it has every item from a complete scan in hand, and only persists the
 * result after `advanceWatermark` returns. A process killed before that persist simply
 * never made the call, so the watermark on disk is whatever it already was.
 */
import type { PollSource, PollSourceName, Watermark } from '../contracts.js';

export function initialWatermark(source: PollSourceName): Watermark {
  return { source, committedAt: 0, idsAtCommittedAt: [] };
}

/**
 * Items from a page (or a whole scan) not yet reflected in `mark`.
 *
 * An item strictly newer than `mark.committedAt` is always new. An item exactly AT
 * `mark.committedAt` is new only if its id is not already in `idsAtCommittedAt` — this is
 * the equal-timestamps case: two Jira issues sharing one `updated` millisecond, one seen
 * on a prior poll and one not. No assumption is made about the page's internal order —
 * `advanceWatermark` and `filterNewItems` both look at every item independently, so an
 * out-of-order page (newest item first) filters and commits identically to a sorted one.
 */
export function filterNewItems<T extends PollSource>(mark: Watermark, page: T[]): T[] {
  const seenAtCommit = new Set(mark.idsAtCommittedAt);
  return page.filter((entry) => {
    if (entry.updated > mark.committedAt) return true;
    if (entry.updated === mark.committedAt) return !seenAtCommit.has(entry.id);
    return false;
  });
}

/**
 * The durable commit: given a complete page/scan, the new watermark is the max `updated`
 * value seen, carrying every id tied at that exact value (so the next poll's
 * equal-timestamps check has something to compare against). A page whose max `updated`
 * does not exceed the current commit leaves the watermark unchanged rather than moving
 * backward or dropping ids a later poll would still need.
 */
export function advanceWatermark(mark: Watermark, page: PollSource[]): Watermark {
  if (!page.length) return mark;
  const maxUpdated = page.reduce((max, entry) => Math.max(max, entry.updated), mark.committedAt);
  if (maxUpdated < mark.committedAt) return mark;
  if (maxUpdated === mark.committedAt) {
    // No item in this page moved the clock forward; ids already on record stand.
    return mark;
  }
  const idsAtMax = page.filter((entry) => entry.updated === maxUpdated).map((entry) => entry.id);
  return { source: mark.source, committedAt: maxUpdated, idsAtCommittedAt: idsAtMax };
}
