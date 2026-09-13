import { describe, expect, it } from 'vitest';

import { idleReason } from '../../src/console/laneVM.js';
import type { QueueItem } from '../../src/shared/console-model.js';

/**
 * An idle slot never claims the queue is empty while the queue screen lists rows.
 *
 * Aaron, 2026-09-13, on the live board with nineteen tickets freshly ingested from his
 * Jira board: the fourth slot read "Waiting for a Ready ticket; nothing is in the queue."
 * The queue screen, one click away, listed twenty-two rows.
 *
 * The sentence counted rows in one state only. Everything ingested was planning, parked
 * or failed, none of them `queued`, so the count was zero and the sentence said so. It
 * was not stale data: the board had every row in hand and described them wrongly.
 *
 * The rule below is about the whole queue rather than that one state, so a state added
 * later cannot silently fall back into "nothing is in the queue".
 */
function item(state: string, ticket: string): QueueItem {
  return {
    id: `Q-${ticket}`, source: 'query', input: 'project = BBZ', ticket, repo: null,
    briefPath: null, branch: null, worktreePath: null, base: null,
    state, reason: null, runKey: null, pr: null, journalIds: [], createdAt: 1, updatedAt: 1,
  } as unknown as QueueItem;
}

const RUNNING = { paused: false, pauseReason: null, on: true };

describe('the sentence under an idle slot', () => {
  it('says the queue is empty only when it is', () => {
    expect(idleReason({ ...RUNNING, items: [] })).toMatch(/nothing is in the queue/);
  });

  // Every state a row can hold, one at a time. None of them is an empty queue.
  for (const state of ['planning', 'parked', 'failed', 'running', 'review', 'blocked']) {
    it(`does not call the queue empty with one ${state} row in it`, () => {
      const said = idleReason({ ...RUNNING, items: [item(state, 'BBZ-1')] });
      expect(said, `"${said}" called a queue holding a ${state} row empty`).not.toMatch(/nothing is in the queue/);
    });
  }

  it('counts what is there when nothing can start', () => {
    const items = [item('parked', 'BBZ-1'), item('planning', 'BBZ-2'), item('failed', 'BBZ-3')];
    const said = idleReason({ ...RUNNING, items });
    expect(said).toMatch(/3/);
    expect(said, 'it never says what is holding them').toMatch(/parked|planning|failed|not ready/i);
  });

  // A finished queue is empty of work, and saying "3 rows" about three done rows would
  // send a reader to a screen where nothing is waiting.
  it('treats a queue of finished rows as nothing waiting', () => {
    expect(idleReason({ ...RUNNING, items: [item('done', 'BBZ-1')] })).toMatch(/nothing is in the queue/);
  });

  it('still leads with the queue being off or paused, which outranks the count', () => {
    const items = [item('parked', 'BBZ-1')];
    expect(idleReason({ items, paused: false, pauseReason: null, on: false })).toMatch(/the queue is off/);
    expect(idleReason({ items, paused: true, pauseReason: 'you paused it', on: true })).toMatch(/paused/);
  });

  it('keeps saying when something is about to start', () => {
    const said = idleReason({ ...RUNNING, items: [item('queued', 'BBZ-1')] });
    expect(said).toMatch(/next tick|starts/i);
  });
});
