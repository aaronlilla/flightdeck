/**
 * Item 5 of the pipeline-hardening brief (2026-09-11): the self loop cuts the console
 * over while an item is waiting on a merge click.
 *
 * `selfCutover.ts` restarts whenever the trunk has moved and `idle()` is true, and the
 * fleet's own idle test counted only `QUEUE_IN_FLIGHT_STATES` -- `planning` and
 * `running`. An item at `review` is the one state where a person is being waited on, and
 * it read as idle. On 2026-09-11 a merge to main restarted the console out from under a
 * pending click.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INTERVIEW_WAIT_REASON, QUEUE_IN_FLIGHT_STATES } from '../../src/forge/intake/queue.js';
import {
  CUTOVER_BLOCKING_STATES, INTERVIEW_REASON, REVIEW_BLOCKS_CUTOVER_MS, cutoverDue, cutoverIdle,
} from '../../src/forge/self/selfCutover.js';
import type { QueueItem } from '../../src/shared/console-model.js';

const NOW = 10_000_000;

function item(state: QueueItem['state'], updatedAt: number = NOW): QueueItem {
  return {
    id: `Q-${state}`, source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'o/r', briefPath: null,
    branch: null, worktreePath: null, base: 'main', state, reason: null, runKey: null, pr: null,
    journalIds: [], createdAt: 1, updatedAt,
  };
}

function git(head: string) {
  return {
    fetch: async () => {},
    remoteHead: async () => head,
    pullFastForward: async () => {},
  };
}

describe('item 5: an item at review blocks a cutover', () => {
  it('reads a fleet holding one review item as not idle', () => {
    expect(cutoverIdle({ items: [item('review')], queueBusy: false, now: NOW })).toBe(false);
  });

  it('refuses the restart a moved trunk would otherwise take', async () => {
    const events: Record<string, unknown>[] = [];
    const due = await cutoverDue({
      checkout: join(tmpdir(), 'self-checkout'), runningHead: 'old', git: git('new'),
      idle: () => cutoverIdle({ items: [item('review')], queueBusy: false, now: NOW }),
      append: (event) => { events.push(event); },
    });

    expect(due.restart).toBe(false);
    expect(events).toEqual([]);
  });

  it('still restarts when the same fleet holds only done and parked rows', async () => {
    const due = await cutoverDue({
      checkout: join(tmpdir(), 'self-checkout'), runningHead: 'old', git: git('new'),
      idle: () => cutoverIdle({ items: [item('done'), item('parked')], queueBusy: false, now: NOW }),
      append: () => {},
    });

    expect(due.restart).toBe(true);
  });

  it('still counts planning and running as busy, unchanged', () => {
    expect(cutoverIdle({ items: [item('planning')], queueBusy: false, now: NOW })).toBe(false);
    expect(cutoverIdle({ items: [item('running')], queueBusy: false, now: NOW })).toBe(false);
  });

  it('is still busy on a mid-advance hop with no item in a blocking state', () => {
    expect(cutoverIdle({ items: [item('queued')], queueBusy: true, now: NOW })).toBe(false);
  });

  it('is idle on an empty queue', () => {
    expect(cutoverIdle({ items: [], queueBusy: false, now: NOW })).toBe(true);
  });

  it('stops holding the cutover once the merge confirm behind it could no longer be spent', () => {
    // The block exists to protect a click. A confirm token lives two hours, so a review
    // row older than that has no click left to void, and holding a restart on it forever
    // would stop the console taking its own fixes for as long as the row sits there.
    const stale = item('review', NOW - REVIEW_BLOCKS_CUTOVER_MS - 1);
    expect(cutoverIdle({ items: [stale], queueBusy: false, now: NOW })).toBe(true);
  });

  it('still holds a review row one millisecond inside the window', () => {
    const fresh = item('review', NOW - REVIEW_BLOCKS_CUTOVER_MS + 1);
    expect(cutoverIdle({ items: [fresh], queueBusy: false, now: NOW })).toBe(false);
  });

  it('holds a planning row however old it is: only review is time-bounded', () => {
    const old = item('planning', NOW - REVIEW_BLOCKS_CUTOVER_MS * 10);
    expect(cutoverIdle({ items: [old], queueBusy: false, now: NOW })).toBe(false);
  });

  it('blocks on every in-flight state the queue itself counts, plus review', () => {
    // The constant is spelled out in `selfCutover.ts` to avoid an import cycle; this is
    // what stops the two lists drifting apart.
    for (const state of QUEUE_IN_FLIGHT_STATES) expect(CUTOVER_BLOCKING_STATES).toContain(state);
    expect(CUTOVER_BLOCKING_STATES).toContain('review');
  });
});

/**
 * An item parked on somebody's answer is not work a restart can interrupt.
 *
 * The escape, measured live on 2026-09-12: one item had sat at `planning` with
 * `reason: 'interview'`, no repo, no brief and no run key since 2026-09-11 17:39, and
 * had been declining every console upgrade for 44 hours. Nothing was running behind it.
 */
describe('an item held for an interview does not block a cutover', () => {
  function parked(updatedAt: number = NOW): QueueItem {
    return { ...item('planning', updatedAt), reason: INTERVIEW_REASON };
  }

  it('reads a fleet holding only a parked item as idle', () => {
    expect(cutoverIdle({ items: [parked()], queueBusy: false, now: NOW })).toBe(true);
  });

  it('stays idle however long the item has been parked', () => {
    expect(cutoverIdle({ items: [parked(NOW - 500 * 60 * 60_000)], queueBusy: false, now: NOW })).toBe(true);
  });

  it('still blocks on a plan that is genuinely being worked, however long it takes', () => {
    const working = item('planning', NOW - 500 * 60 * 60_000);
    expect(cutoverIdle({ items: [working], queueBusy: false, now: NOW })).toBe(false);
  });

  it('still blocks when something else on the board is in flight', () => {
    expect(cutoverIdle({ items: [parked(), item('running')], queueBusy: false, now: NOW })).toBe(false);
  });

  it('blocks on a parked item at any other state, since only planning parks this way', () => {
    const oddly = { ...item('running'), reason: INTERVIEW_REASON };
    expect(cutoverIdle({ items: [oddly], queueBusy: false, now: NOW })).toBe(false);
  });

  it('reads the same reason string the queue hop writes', () => {
    expect(INTERVIEW_REASON).toBe(INTERVIEW_WAIT_REASON);
  });
});
