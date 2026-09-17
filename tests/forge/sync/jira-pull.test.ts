/**
 * R-68 item 3: pullJira -- reuse a newer brief, plan an older one, plan when there is
 * none, and skip a shipped key outright.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PollSourceName } from '../../../src/forge/contracts.js';
import { Journal } from '../../../src/forge/journal.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { FakePollFeed, RawPollItem } from '../../../src/forge/intake/poller.js';
import { findNewestBrief, pullJira } from '../../../src/forge/sync/jira-pull.js';

function tempStore(): QueueStore {
  return new QueueStore(join(mkdtempSync(join(tmpdir(), 'jira-pull-queue-')), 'queue.jsonl'));
}

function tempJournal(): Journal {
  return new Journal(join(mkdtempSync(join(tmpdir(), 'jira-pull-journal-')), 'journal.jsonl'));
}

function feedOf(items: RawPollItem[]): FakePollFeed {
  return { name: 'jira' as PollSourceName, fetchSince: async () => items };
}

describe('findNewestBrief', () => {
  it('picks the highest ms among matching files', () => {
    const brief = findNewestBrief('/briefs', 'BBZ-1', () => [
      'jira_BBZ-1_100.md', 'jira_BBZ-1_9999.md', 'jira_BBZ-2_5000.md', 'notabrief.txt',
    ]);
    expect(brief).toEqual({ path: join('/briefs', 'jira_BBZ-1_9999.md'), ms: 9999 });
  });

  it('returns undefined when nothing matches', () => {
    expect(findNewestBrief('/briefs', 'BBZ-9', () => ['jira_BBZ-1_100.md'])).toBeUndefined();
  });
});

describe('pullJira', () => {
  it('reuses a brief newer than the ticket', async () => {
    const store = tempStore();
    const journal = tempJournal();
    const feed = feedOf([{ id: 'BBZ-1', updated: 1000 }]);
    const result = await pullJira({
      feed, store, briefsDir: '/briefs', shippedKeys: [], journal, now: () => 5000,
      listBriefs: () => ['jira_BBZ-1_2000.md'],
    });
    journal.close();

    expect(result.reused).toEqual(['BBZ-1']);
    expect(result.planned).toEqual([]);
    const item = store.all().find((i) => i.ticket === 'BBZ-1');
    expect(item?.briefPath).toBe(join('/briefs', 'jira_BBZ-1_2000.md'));
  });

  it('plans when the newest brief is older than the ticket', async () => {
    const store = tempStore();
    const journal = tempJournal();
    const feed = feedOf([{ id: 'BBZ-2', updated: 5000 }]);
    const result = await pullJira({
      feed, store, briefsDir: '/briefs', shippedKeys: [], journal, now: () => 9000,
      listBriefs: () => ['jira_BBZ-2_1000.md'],
    });
    journal.close();

    expect(result.planned).toEqual(['BBZ-2']);
    expect(result.reused).toEqual([]);
    const item = store.all().find((i) => i.ticket === 'BBZ-2');
    expect(item?.briefPath).toBeNull();
  });

  it('plans when there is no brief at all', async () => {
    const store = tempStore();
    const journal = tempJournal();
    const feed = feedOf([{ id: 'BBZ-3', updated: 1000 }]);
    const result = await pullJira({
      feed, store, briefsDir: '/briefs', shippedKeys: [], journal, listBriefs: () => [],
    });
    journal.close();

    expect(result.planned).toEqual(['BBZ-3']);
  });

  it('skips a key reconcile-prs already reported shipped', async () => {
    const store = tempStore();
    const journal = tempJournal();
    const feed = feedOf([{ id: 'BBZ-4', updated: 1000 }, { id: 'BBZ-5', updated: 1000 }]);
    const result = await pullJira({
      feed, store, briefsDir: '/briefs', shippedKeys: ['BBZ-4'], journal, listBriefs: () => [],
    });
    journal.close();

    expect(result.skipped).toEqual(['BBZ-4']);
    expect(result.planned).toEqual(['BBZ-5']);
    expect(store.all().map((i) => i.ticket)).toEqual(['BBZ-5']);
  });

  it('journals sync.plan-reused only for a reused ticket', async () => {
    const store = tempStore();
    const journalPath = join(mkdtempSync(join(tmpdir(), 'jira-pull-journal2-')), 'journal.jsonl');
    const journal = new Journal(journalPath);
    const feed = feedOf([{ id: 'BBZ-6', updated: 1000 }]);
    await pullJira({
      feed, store, briefsDir: '/briefs', shippedKeys: [], journal, now: () => 5000,
      listBriefs: () => ['jira_BBZ-6_2000.md'],
    });
    journal.close();

    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.filter((l) => l.includes('"event":"sync.plan-reused"'))).toHaveLength(1);
  });
});
