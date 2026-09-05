/**
 * One poll cycle over one source: fetch since the watermark, emit `source.observed` for
 * every new item, advance and return the watermark (requirements 1, 7, 8).
 *
 * `FakePollFeed` is the seam every real source (Jira REST, Sentry, CloudWatch Insights,
 * Slack, `gh`) implements in production; every specimen in this stream constructs one
 * from a fixture array, never a live client, per the guardrails.
 */
import type { PollSource, PollSourceName, Watermark } from '../contracts.js';
import { advanceWatermark, filterNewItems } from './watermark.js';

/**
 * J2: the source's own text, when the source has it, so the planner sees the ticket
 * rather than a bare key. Only Jira populates this today. Every other fixture leaves it
 * off, and downstream code falls back to the bare id.
 */
export interface PollItemDetail {
  summary: string;
  description: string;
  status: string;
  issuetype: string;
  priority: string;
}

/** A source's own item, before this module stamps it with the feed's source name. */
export interface RawPollItem extends Pick<PollSource, 'id' | 'updated'> {
  detail?: PollItemDetail;
}

export interface FakePollFeed {
  name: PollSourceName;
  /** Returns every item the source has, ignoring the watermark — filtering is this module's job. */
  fetchSince(watermark: Watermark): Promise<RawPollItem[]>;
}

export function observedKey(item: PollSource): string {
  return `${item.name}:${item.id}:${item.updated}`;
}

export interface SourceObservedEvent {
  event: 'source.observed';
  source: PollSourceName;
  sourceId: string;
  updated: number;
  key: string;
  detail?: PollItemDetail;
}

export interface PollResult {
  watermark: Watermark;
  emitted: number;
}

/**
 * Runs one full cycle: fetch, filter to what is new against `mark`, emit one
 * `source.observed` per new item (in `updated`-then-id order, so two runs over the same
 * page never emit in different orders), then return the advanced watermark. The caller
 * persists the returned watermark; this function never writes storage itself, which is
 * what keeps "a crash before the durable commit leaves the prior watermark in force"
 * true — a caller that never reaches the persist step never lost more than one cycle's
 * worth of `source.observed` events, all of which are safely re-emitted next time
 * because they are still filtered against the un-advanced watermark on disk.
 */
export async function runPoll(
  feed: FakePollFeed,
  mark: Watermark,
  emit: (event: SourceObservedEvent) => void,
): Promise<PollResult> {
  const rawPage = await feed.fetchSince(mark);
  // A fixture may hand back bare { id, updated } rows; the feed's own name is the source
  // of truth for which source they came from, not whatever the fixture did or didn't set.
  // `detail`, when a raw item carries one, rides along on the spread untyped by
  // `PollSource` itself -- `filterNewItems` is generic over its element type, so it
  // passes straight through the filter to the emitted event below.
  const page: (PollSource & { detail?: PollItemDetail })[] = rawPage.map((item) => ({ ...item, name: feed.name }));
  const fresh = filterNewItems(mark, page)
    .slice()
    .sort((a, b) => (a.updated - b.updated) || a.id.localeCompare(b.id));
  for (const item of fresh) {
    emit({
      event: 'source.observed',
      source: item.name,
      sourceId: item.id,
      updated: item.updated,
      key: observedKey(item),
      ...(item.detail ? { detail: item.detail } : {}),
    });
  }
  return { watermark: advanceWatermark(mark, page), emitted: fresh.length };
}
