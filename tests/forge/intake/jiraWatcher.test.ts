/**
 * R-11: `runQueueIntakeOnce` against a fake feed and a real `QueueStore` over a temp
 * file, mirroring the fixture style `tests/forge/intake/queue.test.ts` already uses.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runQueueIntakeOnce } from '../../../src/forge/intake/jiraWatcher.js';
import { addTicketItem } from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { FakePollFeed } from '../../../src/forge/intake/poller.js';
import type { Watermark } from '../../../src/forge/contracts.js';
import { initialWatermark } from '../../../src/forge/intake/watermark.js';

function tempStore(): QueueStore {
  const dir = mkdtempSync(join(tmpdir(), 'jira-watcher-'));
  return new QueueStore(join(dir, 'queue.jsonl'));
}

function memoryWatermarks() {
  let mark: Watermark = initialWatermark('jira');
  return { get: () => mark, set: (_source: unknown, next: Watermark) => { mark = next; } };
}

function feedOf(items: { id: string; updated: number }[]): FakePollFeed {
  return { name: 'jira', async fetchSince() { return items; } };
}

describe('runQueueIntakeOnce', () => {
  it('adds one queue item per new ticket, keyed by ticket', async () => {
    const store = tempStore();
    const feed = feedOf([{ id: 'BBZ-1', updated: 1 }, { id: 'BBZ-2', updated: 2 }]);

    const result = await runQueueIntakeOnce([feed], memoryWatermarks(), store, () => {}, () => 1_000);

    expect(result.added).toEqual(['BBZ-1', 'BBZ-2']);
    expect(store.all().map((item) => item.ticket)).toEqual(['BBZ-1', 'BBZ-2']);
  });

  it('a second poll with no new tickets adds none, because the watermark already advanced', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const feed = feedOf([{ id: 'BBZ-1', updated: 1 }]);

    await runQueueIntakeOnce([feed], watermarks, store, () => {}, () => 1_000);
    const second = await runQueueIntakeOnce([feed], watermarks, store, () => {}, () => 2_000);

    expect(second.added).toEqual([]);
    expect(store.all()).toHaveLength(1);
  });

  it('skips a ticket the queue already owns in a non-done state, instead of queuing it twice', async () => {
    const store = tempStore();
    addTicketItem(store, 'BBZ-1', 500);
    const feed = feedOf([{ id: 'BBZ-1', updated: 1 }, { id: 'BBZ-2', updated: 2 }]);

    const result = await runQueueIntakeOnce([feed], memoryWatermarks(), store, () => {}, () => 1_000);

    expect(result.added).toEqual(['BBZ-2']);
    expect(result.skippedOwned).toEqual(['BBZ-1']);
    expect(store.all().filter((item) => item.ticket === 'BBZ-1')).toHaveLength(1);
  });

  it('re-adds a ticket whose only prior item is done', async () => {
    const store = tempStore();
    const first = addTicketItem(store, 'BBZ-1', 500);
    store.append({ id: first.id, ticket: 'BBZ-1', state: 'done', reason: 'shipped', at: 600 });
    const feed = feedOf([{ id: 'BBZ-1', updated: 1 }]);

    const result = await runQueueIntakeOnce([feed], memoryWatermarks(), store, () => {}, () => 1_000);

    expect(result.added).toEqual(['BBZ-1']);
    expect(store.all().filter((item) => item.ticket === 'BBZ-1' && item.state !== 'done')).toHaveLength(1);
  });
});
