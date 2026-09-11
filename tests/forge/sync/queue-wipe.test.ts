/**
 * R-68 item 2: `QueueStore.wipe()` -- soft-deletes every item through the existing
 * `remove` path and journals one `queue.wiped {count}` row on the fleet journal it is
 * handed, never truncating its own log.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { addTicketItem } from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { Journal } from '../../../src/forge/journal.js';

function tempStore(): { store: QueueStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'sync-wipe-queue-')), 'queue.jsonl');
  return { store: new QueueStore(path), path };
}

describe('QueueStore.wipe', () => {
  it('removes every item: all() empty, history rows kept, count returned', () => {
    const { store, path } = tempStore();
    addTicketItem(store, 'BBZ-1', 100);
    addTicketItem(store, 'BBZ-2', 200);
    addTicketItem(store, 'BBZ-3', 300);
    expect(store.all()).toHaveLength(3);

    const count = store.wipe();

    expect(count).toBe(3);
    expect(store.all()).toEqual([]);
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    // 3 creation rows + 3 removal rows: history is append-only, never truncated.
    expect(lines).toHaveLength(6);
  });

  it('journals one queue.wiped row on the fleet journal it is handed', () => {
    const { store } = tempStore();
    addTicketItem(store, 'BBZ-1', 100);
    const journalPath = join(mkdtempSync(join(tmpdir(), 'sync-wipe-journal-')), 'fleet.jsonl');
    const journal = new Journal(journalPath);

    store.wipe(journal);
    journal.close();

    const lines = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    const wiped = lines.filter((line) => line.includes('"event":"queue.wiped"'));
    expect(wiped).toHaveLength(1);
    expect(wiped[0]).toContain('"count":1');
  });

  it('with no journal, wipes without throwing', () => {
    const { store } = tempStore();
    addTicketItem(store, 'BBZ-1', 100);
    expect(() => store.wipe()).not.toThrow();
  });
});
