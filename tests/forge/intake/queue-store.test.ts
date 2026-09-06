import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { QueueStore } from '../../../src/forge/intake/queueStore.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'queue-store-')), 'queue.jsonl');
}

describe('QueueStore', () => {
  it('starts empty against a file that does not exist yet', () => {
    const store = new QueueStore(tempPath());
    expect(store.all()).toEqual([]);
    expect(store.get('nope')).toBeUndefined();
  });

  it('folds a later row onto only the fields it names', () => {
    const store = new QueueStore(tempPath());
    store.append({
      id: 'q1', at: 1000, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: null, briefPath: null,
      state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    store.append({ id: 'q1', at: 2000, state: 'running', repo: 'owner/name', updatedAt: 2000 });

    const item = store.get('q1');
    expect(item).toMatchObject({ id: 'q1', source: 'ticket', ticket: 'ABC-1', state: 'running', repo: 'owner/name' });
    expect(item).not.toHaveProperty('at');
  });

  it('keeps first-seen order across items', () => {
    const store = new QueueStore(tempPath());
    for (const id of ['q1', 'q2', 'q3']) {
      store.append({
        id, at: 1000, source: 'ticket', input: id, ticket: id, repo: null, briefPath: null,
        state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
      });
    }
    expect(store.all().map((item) => item.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('excludes an item once a row sets removedAt, but the row itself survives on disk', () => {
    const path = tempPath();
    const store = new QueueStore(path);
    store.append({
      id: 'q1', at: 1000, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: null, briefPath: null,
      state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    store.append({ id: 'q1', at: 2000, removedAt: 2000, updatedAt: 2000 });
    expect(store.all()).toEqual([]);
    expect(store.get('q1')).toBeUndefined();

    // A fresh reader over the same file sees the same thing: removal is a fact on disk,
    // not something only the writer's own in-memory instance remembers.
    const secondReader = new QueueStore(path);
    expect(secondReader.all()).toEqual([]);
  });
});
