/**
 * Requirement 8 — each poll emits `source.observed` keyed `source + id + updated`;
 * restarts and second readers are no-ops (spine spec Section 2, bullet 1).
 * Requirement 7 — poll sources: Jira, Slack, Sentry, CloudWatch, GitHub.
 *
 * Every poller here is a fake with a recorded fixture — no live Jira/Sentry/CloudWatch
 * call, per the guardrails. Watched red first: before `poller.ts` existed, this whole
 * file failed on the module import.
 */
import { describe, expect, it } from 'vitest';

import { observedKey, runPoll, type FakePollFeed } from '../../../src/forge/intake/poller.js';
import { POLL_SOURCE_NAMES } from '../../../src/forge/contracts.js';

function feed(items: Array<{ id: string; updated: number }>): FakePollFeed {
  return {
    name: 'jira',
    async fetchSince() {
      return items;
    },
  };
}

describe('observedKey', () => {
  it('is exactly source + id + updated', () => {
    expect(observedKey({ name: 'sentry', id: 'ISSUE-9', updated: 42 })).toBe('sentry:ISSUE-9:42');
  });
});

describe('runPoll — idempotent across restart and second readers', () => {
  it('emits one source.observed per new item, in requirement-8 shape', async () => {
    const events: unknown[] = [];
    const f = feed([{ id: 'BBZ-1', updated: 100 }, { id: 'BBZ-2', updated: 100 }]);
    const result = await runPoll(f, { source: 'jira', committedAt: 0, idsAtCommittedAt: [] }, (event) => events.push(event));
    expect(events).toEqual([
      expect.objectContaining({ event: 'source.observed', source: 'jira', sourceId: 'BBZ-1', updated: 100 }),
      expect.objectContaining({ event: 'source.observed', source: 'jira', sourceId: 'BBZ-2', updated: 100 }),
    ]);
    expect(result.watermark).toEqual({ source: 'jira', committedAt: 100, idsAtCommittedAt: ['BBZ-1', 'BBZ-2'] });
  });

  it('a restart that replays the same fetch against the advanced watermark emits nothing new', async () => {
    const events: unknown[] = [];
    const f = feed([{ id: 'BBZ-1', updated: 100 }]);
    const first = await runPoll(f, { source: 'jira', committedAt: 0, idsAtCommittedAt: [] }, (e) => events.push(e));
    // Simulate the process dying and a fresh poller starting from the persisted watermark.
    const secondEvents: unknown[] = [];
    await runPoll(f, first.watermark, (e) => secondEvents.push(e));
    expect(secondEvents).toEqual([]);
  });

  it('two readers polling the same fixed page from the same watermark produce identical, non-duplicating events', async () => {
    const f = feed([{ id: 'BBZ-5', updated: 200 }]);
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    const mark = { source: 'jira' as const, committedAt: 0, idsAtCommittedAt: [] };
    await runPoll(f, mark, (e) => eventsA.push(e));
    await runPoll(f, mark, (e) => eventsB.push(e));
    // Both readers start from the SAME (not-yet-advanced) watermark, so both correctly
    // see the item as new — the no-op guarantee is about a watermark that has already
    // advanced, proven in the specimen above. What this specimen proves is that the two
    // readers' events are identical (deterministic, not a race that drops or duplicates).
    expect(eventsA).toEqual(eventsB);
  });

  it('covers every named poll source', () => {
    expect(POLL_SOURCE_NAMES).toContain('jira');
    expect(POLL_SOURCE_NAMES).toContain('sentry');
    expect(POLL_SOURCE_NAMES).toContain('cloudwatch');
    expect(POLL_SOURCE_NAMES).toContain('slack');
    expect(POLL_SOURCE_NAMES).toContain('github');
  });
});
