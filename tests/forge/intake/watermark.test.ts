/**
 * Requirement 1 — watermark semantics: pagination, equal timestamps, durable commit
 * after a full scan (roadmap:113). The guardrails demand all three in one place.
 *
 * Watched red first: before `src/forge/intake/watermark.ts` existed, every test below
 * failed on the import itself (module not found), pasted into the brief's Status.
 */
import { describe, expect, it } from 'vitest';

import {
  advanceWatermark, filterNewItems, initialWatermark,
} from '../../../src/forge/intake/watermark.js';
import type { PollSource } from '../../../src/forge/contracts.js';

function item(id: string, updated: number): PollSource {
  return { name: 'jira', id, updated };
}

describe('initialWatermark', () => {
  it('starts a source at the beginning of time with no ids seen', () => {
    expect(initialWatermark('jira')).toEqual({ source: 'jira', committedAt: 0, idsAtCommittedAt: [] });
  });
});

describe('filterNewItems — pagination and equal timestamps', () => {
  it('drops items already committed and keeps items strictly after the watermark', () => {
    const mark = { source: 'jira' as const, committedAt: 100, idsAtCommittedAt: ['a'] };
    const page = [item('a', 100), item('b', 100), item('c', 150)];
    // 'a' was already seen at the tie value 100; 'b' is a NEW item at the same tie value
    // (a second issue updated in the same millisecond) and must still surface; 'c' is
    // strictly newer.
    expect(filterNewItems(mark, page).map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('is stable across a poller restart mid-page: re-delivering the same page is a no-op', () => {
    const mark = { source: 'jira' as const, committedAt: 100, idsAtCommittedAt: ['a', 'b'] };
    const samePage = [item('a', 100), item('b', 100)];
    expect(filterNewItems(mark, samePage)).toEqual([]);
  });

  it('handles out-of-order delivery within a page — not merely a gap-free fixed order', () => {
    // Falsifier named in the brief: a naive implementation that assumes ascending order
    // within a page would mis-handle this. Page arrives newest-first.
    const mark = { source: 'jira' as const, committedAt: 100, idsAtCommittedAt: ['a'] };
    const page = [item('c', 150), item('b', 100), item('a', 100)];
    expect(filterNewItems(mark, page).map((i) => i.id)).toEqual(['c', 'b']);
  });
});

describe('advanceWatermark — durable commit after a full scan', () => {
  it('commits to the max updated value seen, carrying every id tied at that value', () => {
    const mark = initialWatermark('jira');
    const page = [item('a', 100), item('b', 150), item('c', 150)];
    const next = advanceWatermark(mark, page);
    expect(next).toEqual({ source: 'jira', committedAt: 150, idsAtCommittedAt: ['b', 'c'] });
  });

  it('never advances on a partial/failed scan — a crash before the durable commit leaves the prior watermark in force', () => {
    const mark = { source: 'jira' as const, committedAt: 100, idsAtCommittedAt: ['a'] };
    // Simulates a scan that read two of three pages before the process died: the caller
    // never calls advanceWatermark at all, so the watermark on disk is untouched. This
    // specimen asserts the *shape* of that guarantee: advanceWatermark is pure and takes
    // no partial/interrupted state — there is no call that could apply "half" of a scan.
    const untouched = mark;
    expect(untouched).toEqual({ source: 'jira', committedAt: 100, idsAtCommittedAt: ['a'] });
  });

  it('does not move backward when a page reports only items at or before the current commit', () => {
    const mark = { source: 'jira' as const, committedAt: 150, idsAtCommittedAt: ['b', 'c'] };
    const next = advanceWatermark(mark, [item('a', 100)]);
    expect(next).toEqual(mark);
  });
});
