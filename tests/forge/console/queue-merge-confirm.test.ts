/**
 * Item 4, review round 2 (2026-09-11): the Queue view's own Merge click was still voided
 * by a restart.
 *
 * The durable confirm added in round 1 covers `POST /run/:id/merge`. The Queue view uses
 * `POST /queue/:id/merge`, which goes through the same confirm gate with no descriptor,
 * so nothing was persisted and the refusal after a restart could not even say the token
 * had expired. That is the surface the reported symptom came from.
 *
 * This drives the route through a real server, with the gate captured, because the gap is
 * in what the route HANDS the gate, not in what the gate does with it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { QueueRoutes } from '../../../src/forge/console/queue-route.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

let dir: string;
let queueStore: QueueStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-merge-confirm-'));
  mkdirSync(join(dir, 'lanes'), { recursive: true });
  process.env['FORGE_HOME'] = dir;
  new Journal(join(dir, 'fleet.jsonl')).close();
  writeFileSync(join(dir, 'model-policy.json'), JSON.stringify({ version: 1, classes: {} }), 'utf8');
  queueStore = new QueueStore(join(dir, 'queue.jsonl'));
});

afterEach(() => {
  new Inbox(join(dir, 'inbox'));
  new Lanes(join(dir, 'lanes'));
});

function reviewItem(): QueueItem {
  const item: QueueItem = {
    id: 'Q-merge-1', source: 'ticket', input: 'ABC-9', ticket: 'ABC-9', repo: 'owner/name',
    briefPath: null, branch: 'feature/abc-9', worktreePath: null, base: 'develop',
    state: 'review', reason: null, runKey: null,
    pr: { no: 9, url: 'https://github.com/owner/name/pull/9', draft: false },
    journalIds: [], createdAt: 1, updatedAt: 1,
  };
  queueStore.append({ at: 1, ...item });
  return item;
}

describe('item 4 round 2: the Queue view Merge click is persisted like every other one', () => {
  it('hands the confirm gate a descriptor naming the item, so a restart can rebuild it', async () => {
    reviewItem();
    const seen: Array<Record<string, unknown> | undefined> = [];
    const routes = new QueueRoutes({
      store: queueStore,
      search: { searchKeys: async () => [] },
      authorized: () => true,
      readPaused: () => false,
      writePaused: () => {},
      maxInFlight: 2,
      publish: () => {},
      mergeDeps: {} as never,
      confirmGate: async (_body, _source, _blast, _act, descriptor) => {
        seen.push(descriptor as Record<string, unknown> | undefined);
        return { status: 202, body: { ok: false, pending: true } };
      },
    });

    await routes.handle(
      '/queue/Q-merge-1/merge',
      Object.assign(Readable.from(['{}']), {
        method: 'POST', url: '/queue/Q-merge-1/merge', headers: {},
      }) as never,
      { setHeader: () => {}, end: () => {}, writeHead: () => {} } as never,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'queue-merge', itemId: 'Q-merge-1' });
  });
});
