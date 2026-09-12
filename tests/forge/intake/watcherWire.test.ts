/**
 * R-11 part 2: the production wiring that plugs `runWatcherIntake` into `forge up` --
 * `readWatcherPollSeconds`, `watcherJql`, and `watcherTick`'s delivery of sends/closes
 * plus its journal-on-change rule. Same discipline as `watcherIntake.test.ts`: a fake
 * feed, an in-memory watermark store, a temp-file queue store, no network.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PollSourceName, Watermark } from '../../../src/forge/contracts.js';
import { Journal } from '../../../src/forge/journal.js';
import type { WatermarkStore } from '../../../src/forge/intake/once.js';
import type { FakePollFeed, RawPollItem } from '../../../src/forge/intake/poller.js';
import { addTicketItem } from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { initialWatermark } from '../../../src/forge/intake/watermark.js';
import { readWatcherPollSeconds, watcherJql, watcherTick } from '../../../src/forge/intake/watcherWire.js';

function memoryWatermarks(): WatermarkStore {
  const marks = new Map<PollSourceName, Watermark>();
  return {
    get: (source) => marks.get(source) ?? initialWatermark(source),
    set: (source, mark) => { marks.set(source, mark); },
  };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tempStore(): QueueStore {
  return new QueueStore(join(tempDir('watcher-wire-queue-'), 'queue.jsonl'));
}

function tempJournal(): { journal: Journal; path: string } {
  const path = join(tempDir('watcher-wire-journal-'), 'journal.jsonl');
  return { journal: new Journal(path), path };
}

function feedOf(items: RawPollItem[]): FakePollFeed {
  return { name: 'jira-watch' as PollSourceName, fetchSince: async () => items };
}

describe('readWatcherPollSeconds', () => {
  it('defaults to 30s -- the chain shares the env var name but not the default', () => {
    expect(readWatcherPollSeconds({})).toBe(30);
  });

  it('reads FORGE_CHAIN_POLL_S when set', () => {
    expect(readWatcherPollSeconds({ FORGE_CHAIN_POLL_S: '90' })).toBe(90);
  });

  it('falls back to 30s on a non-positive or unparsable value', () => {
    expect(readWatcherPollSeconds({ FORGE_CHAIN_POLL_S: '0' })).toBe(30);
    expect(readWatcherPollSeconds({ FORGE_CHAIN_POLL_S: 'nope' })).toBe(30);
  });
});

describe('watcherJql', () => {
  const MINE = 'project = BBZ AND assignee = currentUser() AND statusCategory != Done AND status != "In Review/QA"';

  it('clause 1 excludes Done and In Review/QA -- new work only (Aaron, 2026-09-11: never queue a shipped or in-review ticket)', () => {
    expect(watcherJql('BBZ')).toBe(`${MINE} ORDER BY updated ASC`);
    expect(watcherJql('BBZ', [])).toBe(`${MINE} ORDER BY updated ASC`);
  });

  it('with two owned keys, clause 2 keeps owned tickets visible whatever their status, so a Done move still closes the lane', () => {
    expect(watcherJql('BBZ', ['BBZ-1', 'BBZ-2'])).toBe(
      `((${MINE}) OR key in (BBZ-1, BBZ-2)) ORDER BY updated ASC`,
    );
  });

  it('never equals the bare whole-board query the R-68 fix replaces', () => {
    expect(watcherJql('BBZ')).not.toBe('project = BBZ ORDER BY updated ASC');
    expect(watcherJql('BBZ', ['BBZ-1'])).not.toBe('project = BBZ ORDER BY updated ASC');
  });
});

describe('watcherTick', () => {
  it('builds its feed from that tick\'s own owned keys', async () => {
    const store = tempStore();
    addTicketItem(store, 'BBZ-9', 1000);
    const watermarks = memoryWatermarks();
    const { journal } = tempJournal();
    let seen: string[] | undefined;

    await watcherTick({
      feedFor: (ownedKeys) => { seen = ownedKeys; return feedOf([]); },
      watermarks, store, journal,
    });

    expect(seen).toEqual(['BBZ-9']);
  });

  it('a done item is never re-added: ownedItem covers done items too', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-1', 1000);
    store.append({ id: item.id, at: 1000, state: 'done', updatedAt: 1000 });
    const watermarks = memoryWatermarks();
    const feed = feedOf([{ id: 'BBZ-1', updated: 2000 }]);
    const { journal } = tempJournal();

    const result = await watcherTick({ feedFor: () => feed, watermarks, store, journal });

    expect(result.addedTickets).toEqual([]);
    expect(store.all().filter((i) => i.ticket === 'BBZ-1')).toHaveLength(1);
  });

  it('under a fake feed, the first poll adds a queue item for a new ticket', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const feed = feedOf([{ id: 'BBZ-1', updated: 100 }]);
    const { journal } = tempJournal();

    const result = await watcherTick({ feedFor: () => feed, watermarks, store, journal });

    expect(result.addedTickets).toEqual(['BBZ-1']);
    expect(store.all().map((i) => i.ticket)).toEqual(['BBZ-1']);
  });

  it('delivers a send to the owning run\'s inbox via the sendTo seam, and skips a send with no runKey', async () => {
    const store = tempStore();
    const item = addTicketItem(store, 'BBZ-1', 1000);
    store.append({ id: item.id, at: 1000, state: 'running', updatedAt: 1000, runKey: 'run-1' } as never);
    const watermarks = memoryWatermarks();
    const feed = feedOf([{
      id: 'BBZ-1', updated: 200,
      detail: {
        summary: 'x', description: '', status: 'In Progress', issuetype: 'Bug', priority: 'High',
        latestComment: { author: 'Jason', body: 'try again' },
      },
    }]);
    const { journal } = tempJournal();
    const sent: Array<{ run: string; text: string }> = [];

    const result = await watcherTick({
      feedFor: () => feed, watermarks, store, journal, sendTo: (run, text) => { sent.push({ run, text }); },
    });

    expect(result.sends).toEqual([{ itemId: item.id, ticket: 'BBZ-1', text: 'Jason: try again' }]);
    expect(sent).toEqual([{ run: 'run-1', text: 'Jason: try again' }]);
  });

  it('a Done move closes the queue item via store.append rather than removing it', async () => {
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
    const { journal } = tempJournal();

    const result = await watcherTick({ feedFor: () => feed, watermarks, store, journal, now: () => 5000 });

    expect(result.closed).toEqual([{ itemId: item.id, ticket: 'BBZ-1', reason: 'closed in Jira' }]);
    expect(store.get(item.id)?.state).toBe('done');
  });

  it('journals one watcher.poll event when something changed', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const feed = feedOf([{ id: 'BBZ-1', updated: 100 }]);
    const { journal, path } = tempJournal();

    await watcherTick({ feedFor: () => feed, watermarks, store, journal });
    journal.close?.();

    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const pollLines = lines.filter((line) => line.includes('"event":"watcher.poll"'));
    expect(pollLines).toHaveLength(1);
    expect(pollLines[0]).toContain('added 1, sent 0, closed 0');
  });

  it('item 9 (2026-09-11): 15 new tickets, width 4, inFlight 0 -- one poll adds 4 and defers 11', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const items = Array.from({ length: 15 }, (_, i) => ({ id: `BBZ-${i + 1}`, updated: 100 + i }));
    const feed = feedOf(items);
    const { journal, path } = tempJournal();

    const result = await watcherTick({ feedFor: () => feed, watermarks, store, journal, maxInFlight: () => 4 });
    journal.close?.();

    expect(result.addedTickets).toHaveLength(4);
    expect(store.all()).toHaveLength(4);
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const deferredLines = lines.filter((line) => line.includes('"event":"watcher.deferred"'));
    expect(deferredLines).toHaveLength(1);
    expect(deferredLines[0]).toContain('deferred 11');
  });

  it('edge: width 0 defers every brand-new ticket and adds none', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `BBZ-${i + 1}`, updated: 100 + i }));
    const feed = feedOf(items);
    const { journal, path } = tempJournal();

    const result = await watcherTick({ feedFor: () => feed, watermarks, store, journal, maxInFlight: () => 0 });
    journal.close?.();

    expect(result.addedTickets).toEqual([]);
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const deferredLines = lines.filter((line) => line.includes('"event":"watcher.deferred"'));
    expect(deferredLines[0]).toContain('deferred 5');
  });

  it('edge: tickets already queued are never budgeted -- only brand-new ones defer', async () => {
    const store = tempStore();
    for (let i = 1; i <= 15; i += 1) addTicketItem(store, `BBZ-${i}`, 1000);
    const watermarks = memoryWatermarks();
    const feed = feedOf(Array.from({ length: 15 }, (_, i) => ({ id: `BBZ-${i + 1}`, updated: 2000 + i })));
    const { journal, path } = tempJournal();

    const result = await watcherTick({ feedFor: () => feed, watermarks, store, journal, maxInFlight: () => 4 });
    journal.close?.();

    expect(result.addedTickets).toEqual([]);
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/);
  });

  it('edge: a ticket deferred on one poll and gone from the feed on the next causes no error', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const { journal } = tempJournal();
    const firstFeed = feedOf(Array.from({ length: 6 }, (_, i) => ({ id: `BBZ-${i + 1}`, updated: 100 + i })));

    const first = await watcherTick({ feedFor: () => firstFeed, watermarks, store, journal, maxInFlight: () => 4 });
    expect(first.addedTickets).toHaveLength(4);

    // BBZ-5 and BBZ-6 were deferred; the feed no longer returns BBZ-6 on the next poll
    // (removed from Jira, or no longer matches the JQL) -- the second poll must not
    // error and must not add it.
    const secondFeed = feedOf([{ id: 'BBZ-5', updated: 300 }]);
    const second = await watcherTick({ feedFor: () => secondFeed, watermarks, store, journal, maxInFlight: () => 4 });
    expect(second.addedTickets).toEqual(['BBZ-5']);
    expect(store.all().map((i) => i.ticket)).not.toContain('BBZ-6');
  });

  it('journals nothing on an idle poll -- an unchanged board costs no journal growth', async () => {
    const store = tempStore();
    const watermarks = memoryWatermarks();
    const feed = feedOf([]);
    const { journal, path } = tempJournal();

    await watcherTick({ feedFor: () => feed, watermarks, store, journal });
    journal.close?.();

    // Nothing was ever appended, so the file itself is never created -- that absence
    // is the proof of no journal growth, not an empty file.
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/);
  });
});
