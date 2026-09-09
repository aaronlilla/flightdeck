import { mkdtempSync, writeFileSync } from 'node:fs';
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

describe('the store reads its log incrementally', () => {
  const first = {
    id: 'q1', at: 1000, source: 'ticket' as const, input: 'ABC-1', ticket: 'ABC-1', repo: null, briefPath: null,
    state: 'queued' as const, reason: null, runKey: null, pr: null, journalIds: [] as string[], createdAt: 1000, updatedAt: 1000,
  };

  it('a repeat all() reads nothing, and an append costs only its own row', () => {
    const store = new QueueStore(tempPath());
    store.append({ ...first });
    store.all();
    const after = store.bytesRead;
    store.all();
    store.all();
    expect(store.bytesRead).toBe(after);
    store.append({ id: 'q1', at: 2000, state: 'running', updatedAt: 2000 });
    store.all();
    expect(store.bytesRead - after).toBeLessThan(120);
    expect(store.get('q1')?.state).toBe('running');
  });

  it('sees a row another process appended, and a removal it wrote', () => {
    const path = tempPath();
    const store = new QueueStore(path);
    store.append({ ...first });
    expect(store.all()).toHaveLength(1);
    const other = new QueueStore(path);
    other.append({ id: 'q1', at: 3000, removedAt: 3000, updatedAt: 3000 });
    expect(store.all()).toEqual([]);
    expect(store.history('q1')).toHaveLength(2);
  });

  it('starts over when the log shrank', () => {
    const path = tempPath();
    const store = new QueueStore(path);
    store.append({ ...first });
    store.append({ ...first, id: 'q2' });
    expect(store.all()).toHaveLength(2);
    writeFileSync(path, '', 'utf8');
    expect(store.all()).toEqual([]);
    store.append({ ...first, id: 'q3' });
    expect(store.all().map((item) => item.id)).toEqual(['q3']);
  });
});
