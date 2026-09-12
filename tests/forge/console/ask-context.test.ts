import { describe, expect, it } from 'vitest';

import { askContextFor, askContextForRuns, queueIdFrom } from '../../../src/forge/console/askContext.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

/**
 * The escape, measured live on 2026-09-12: 92 open questions on the console, and 90 of
 * them pointed at a queue item that no longer exists. Answering one would post to work
 * that has gone. Aaron, on one of them: "a worthless question that can never be answered
 * by a human reasonably without extensive research."
 */

function item(id: string, ticket: string | null): QueueItem {
  return {
    id, source: 'ticket', input: ticket ?? id, ticket, repo: 'o/r', briefPath: null,
    branch: null, worktreePath: null, base: 'main', state: 'planning', reason: null,
    runKey: null, pr: null, journalIds: [], createdAt: 1, updatedAt: 1,
  } as unknown as QueueItem;
}

const input = { items: [item('Q-656086f4', 'BBZ-289')], laneIds: new Set(['2026-09-09-a-brief']) };

describe('queueIdFrom', () => {
  it('reads the queue id out of a run reference', () => {
    expect(queueIdFrom('item:Q-dc5d6c90')).toBe('Q-dc5d6c90');
  });

  it('answers null for a lane id, which is not a queue reference', () => {
    expect(queueIdFrom('2026-09-09-a-brief')).toBeNull();
  });
});

describe('an ask pointing at a queue item', () => {
  it('is live and names its ticket when the item is still there', () => {
    expect(askContextFor('item:Q-656086f4', input)).toEqual({ live: true, label: 'BBZ-289' });
  });

  it('is dead when the item has been pruned', () => {
    expect(askContextFor('item:Q-dc5d6c90', input)).toEqual({ live: false, label: null });
  });
});

describe('an ask pointing at a lane', () => {
  it('is live while the fleet still knows the lane', () => {
    expect(askContextFor('2026-09-09-a-brief', input).live).toBe(true);
  });

  it('is dead once the lane is gone', () => {
    expect(askContextFor('2026-09-09-vanished', input).live).toBe(false);
  });
});

describe('an ask with nothing to point at', () => {
  it('reads live, because a missing reference is not evidence the work is gone', () => {
    expect(askContextFor('', input).live).toBe(true);
    expect(askContextFor('system', input).live).toBe(true);
    expect(askContextForRuns([], input).live).toBe(true);
  });
});

describe('an ask naming several runs', () => {
  it('is live when any one of them is', () => {
    expect(askContextForRuns(['item:Q-gone', 'item:Q-656086f4'], input)).toEqual({ live: true, label: 'BBZ-289' });
  });

  it('is dead only when every one of them is gone', () => {
    expect(askContextForRuns(['item:Q-gone', 'item:Q-alsogone'], input).live).toBe(false);
  });
});
