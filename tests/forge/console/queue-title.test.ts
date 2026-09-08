/**
 * W1: a queue item carries a title a person can read, and `GET /queue` fills it at
 * read time -- so an item written to disk before this existed gets one with no
 * migration.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { queueTitleFor } from '../../../src/forge/console/queue-title.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import type { QueueItem, QueueResponse } from '../../../src/shared/console-model.js';

function item(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: 'Q-1', source: 'brief', input: '', ticket: null, repo: null, briefPath: null,
    branch: null, worktreePath: null, base: null, state: 'queued', reason: null,
    runKey: null, pr: null, journalIds: [], createdAt: 0, updatedAt: 0, title: null,
    ...overrides,
  };
}

describe('queueTitleFor', () => {
  it('titles a brief item from its heading, without the Goal: prefix', () => {
    const brief = '# Goal: board-readability — words you can read\n\nrepo: aaronlilla/flightdeck\n';
    expect(queueTitleFor(item({ source: 'brief', input: brief }))).toBe('board-readability — words you can read');
  });

  it('titles a brief with a bare-slug heading from its first body paragraph', () => {
    const brief = '# lint\n\nThe console prints a raw brief where a title belongs.\n';
    expect(queueTitleFor(item({ source: 'brief', input: brief })))
      .toBe('The console prints a raw brief where a title belongs.');
  });

  it('titles a brief with no heading at all from its first paragraph', () => {
    const brief = 'the queue page and the board look totally ridiculous\n\nmore text\n';
    expect(queueTitleFor(item({ source: 'brief', input: brief })))
      .toBe('The queue page and the board look totally ridiculous');
  });

  it('titles a ticket item from the heading of its brief on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-title-'));
    const path = join(dir, 'brief.md');
    writeFileSync(path, '# BB-9: Deposits round the wrong way\n\nbody\n', 'utf8');
    expect(queueTitleFor(item({ source: 'ticket', input: 'BB-9', ticket: 'BB-9', briefPath: path })))
      .toBe('Deposits round the wrong way');
  });

  it('gives a ticket item with no brief on disk no title at all', () => {
    expect(queueTitleFor(item({ source: 'ticket', input: 'BB-9', ticket: 'BB-9', briefPath: null }))).toBeNull();
    expect(queueTitleFor(item({ source: 'query', input: 'sprint = 42', briefPath: join(tmpdir(), 'nope.md') }))).toBeNull();
  });
});

describe('GET /queue', () => {
  let dir: string;
  let server: ForgeServer;
  let base: string;
  const token = 'the-token';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'queue-title-route-'));
    mkdirSync(join(dir, 'lanes'), { recursive: true });
    process.env['FORGE_HOME'] = dir;
    new Journal(join(dir, 'fleet.jsonl')).close();
    const modelPolicyPath = join(dir, 'model-policy.json');
    writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
    // An item as it sits on disk today: written before `title` existed, so the row
    // carries no such field at all.
    writeFileSync(
      join(dir, 'queue.jsonl'),
      `${JSON.stringify({
        id: 'Q-old', at: 1, source: 'brief', state: 'queued',
        input: '# Goal: ask-cards — a question card a person can answer\n\nrepo: aaronlilla/flightdeck\n',
        ticket: null, repo: null, briefPath: null, branch: null, worktreePath: null, base: null,
        reason: null, runKey: null, pr: null, journalIds: [], createdAt: 1, updatedAt: 1,
      })}\n`,
      'utf8',
    );
    server = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0, token, modelPolicyPath,
      queueStore: new QueueStore(join(dir, 'queue.jsonl')),
      queueSearch: { searchKeys: async () => [] }, queueMaxInFlight: 2,
    });
    base = `http://127.0.0.1:${await server.listen()}`;
  });

  afterEach(async () => { await server.close(); });

  it('carries a title for an item stored without one', async () => {
    const response = await fetch(`${base}/queue`, { headers: { 'x-forge-token': token } });
    const body = await response.json() as QueueResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.title).toBe('ask-cards — a question card a person can answer');
  });
});
