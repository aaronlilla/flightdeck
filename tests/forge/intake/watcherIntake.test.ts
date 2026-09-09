/**
 * R-11: the Jira watcher bridge -- `runWatcherIntake` -- against a fake feed, a fake
 * watermark store and an in-memory queue store. No network, no disk beyond what the
 * fakes below simulate, same discipline as `once.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { initialWatermark } from '../../../src/forge/intake/watermark.js';
import type { WatermarkStore } from '../../../src/forge/intake/once.js';
import type { FakePollFeed, RawPollItem } from '../../../src/forge/intake/poller.js';
import { runWatcherIntake } from '../../../src/forge/intake/watcherIntake.js';
import { addTicketItem } from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { PollSourceName, Watermark } from '../../../src/forge/contracts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function memoryWatermarks(): WatermarkStore {
  const marks = new Map<PollSourceName, Watermark>();
  return {
    get: (source) => marks.get(source) ?? initialWatermark(source),
    set: (source, mark) => { marks.set(source, mark); },
  };
}

function tempStore(): QueueStore {
  return new QueueStore(join(mkdtempSync(join(tmpdir(), 'watcher-intake-')), 'queue.jsonl'));
}

function feedOf(items: RawPollItem[]): FakePollFeed {
  return { name: 'jira-watch' as PollSourceName, fetchSince: async () => items };
}

describe('runWatcherIntake', () => {
  it('adds a queue item for each new ticket, and a second poll of the same page adds none', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const feed = feedOf([
      { id: 'BBZ-1', updated: 100 },
      { id: 'BBZ-2', updated: 100 },
    ]);

    const first = await runWatcherIntake({ feed, watermarks, store });
    expect(first.addedTickets).toEqual(['BBZ-1', 'BBZ-2']);
    expect(store.all().map((i) => i.ticket)).toEqual(['BBZ-1', 'BBZ-2']);

    const second = await runWatcherIntake({ feed, watermarks, store });
    expect(second.addedTickets).toEqual([]);
    expect(store.all()).toHaveLength(2);
  });

  it('does not re-add a ticket the queue already owns in a non-done state', async () => {
    const store = tempStore();
    addTicketItem(store, 'BBZ-1', 1000);
    const watermarks = memoryWatermarks();
    const feed = feedOf([{ id: 'BBZ-1', updated: 100 }]);

    const result = await runWatcherIntake({ feed, watermarks, store });
    expect(result.addedTickets).toEqual([]);
    expect(store.all()).toHaveLength(1);
  });

  it('a comment on a ticket the queue owns in a sendable state produces one send and no new item', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-1', 1000);
    store.append({ id: item.id, at: 1000, state: 'running', updatedAt: 1000 });
    const watermarks = memoryWatermarks();
    const feed = feedOf([{
      id: 'BBZ-1', updated: 200,
      detail: {
        summary: 'x', description: '', status: 'In Progress', issuetype: 'Bug', priority: 'High',
        latestComment: { author: 'Jason', body: 'try again with the QA build' },
      },
    }]);

    const result = await runWatcherIntake({ feed, watermarks, store });
    expect(result.addedTickets).toEqual([]);
    expect(result.sends).toEqual([{ itemId: item.id, ticket: 'BBZ-1', text: 'Jason: try again with the QA build' }]);
    expect(store.all()).toHaveLength(1);
  });

  it('an owned ticket with no comment, or in a non-sendable state, produces no send', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-1', 1000); // still 'queued'
    const watermarks = memoryWatermarks();
    const feed = feedOf([{
      id: 'BBZ-1', updated: 200,
      detail: {
        summary: 'x', description: '', status: 'Open', issuetype: 'Bug', priority: 'High',
        latestComment: { author: 'Jason', body: 'hey' },
      },
    }]);

    const result = await runWatcherIntake({ feed, watermarks, store });
    expect(result.sends).toEqual([]);
    expect(result.addedTickets).toEqual([]);
    expect(item.state).toBe('queued');
  });

  it('an owned ticket whose status category moves to Done retires the lane instead of adding or sending', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-1', 1000);
    store.append({ id: item.id, at: 1000, state: 'review', updatedAt: 1000 });
    const watermarks = memoryWatermarks();
    const feed = feedOf([{
      id: 'BBZ-1', updated: 200,
      detail: {
        summary: 'x', description: '', status: 'Done', issuetype: 'Bug', priority: 'High',
        statusCategory: 'Done',
      },
    }]);

    const result = await runWatcherIntake({ feed, watermarks, store });
    expect(result.closed).toEqual([{ itemId: item.id, ticket: 'BBZ-1', reason: 'closed in Jira' }]);
    expect(result.addedTickets).toEqual([]);
    expect(result.sends).toEqual([]);
  });
});
