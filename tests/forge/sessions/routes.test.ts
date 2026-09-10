/**
 * `POST /sessions/event`, `POST /journal/append`, `POST /sessions/:id/message` and
 * `GET /sessions/:id/inbox` over a real, ephemeral-port `ForgeServer` -- same pattern as
 * `tests/forge/server-send.test.ts`. Never touches the live console on 4120.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { Registry } from '../../../src/forge/registry.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import { ForgeServer } from '../../../src/forge/server.js';

let dir: string;
let server: ForgeServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-sessions-routes-'));
  process.env['FORGE_HOME'] = dir;
  const lanes = new Lanes(join(dir, 'lanes'));
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.close();
  const registry = new Registry(join(dir, 'registry'));

  server = new ForgeServer({
    lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'), registry, port: 0,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
});

function journalLines(): string[] {
  try {
    return readFileSync(join(dir, 'fleet.jsonl'), 'utf8').split('\n').filter((line) => line.trim());
  } catch {
    return [];
  }
}

describe('POST /sessions/event', () => {
  it('journals a session.started row and returns its seq', async () => {
    const res = await fetch(`${base}/sessions/event`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'session.started', session: 's1', cwd: 'C:/dev' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { seq: number[] };
    expect(body.seq).toEqual([1]);
    expect(journalLines()).toHaveLength(1);
  });

  it('401s a bad token and writes nothing', async () => {
    const res = await fetch(`${base}/sessions/event`, {
      method: 'POST',
      headers: { 'x-forge-token': 'wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'session.started', session: 's1' }),
    });
    expect(res.status).toBe(401);
    expect(journalLines()).toHaveLength(0);
  });
});

describe('POST /journal/append', () => {
  it('accepts one row and returns its stamped seq', async () => {
    const res = await fetch(`${base}/journal/append`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'note', actor: 'ledger-client' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { seq: number[] };
    expect(body.seq).toEqual([1]);
  });

  it('accepts an array of rows and returns one seq per row', async () => {
    const res = await fetch(`${base}/journal/append`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify([{ event: 'note' }, { event: 'note' }]),
    });
    const body = await res.json() as { seq: number[] };
    expect(body.seq).toEqual([1, 2]);
  });
});

describe('session id path safety', () => {
  it('refuses a session id that would escape session-inbox/ (path traversal)', async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent('../../evil')}/message`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', from: 'console' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an unsafe session id on the inbox GET route too', async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent('../../evil')}/inbox`, {
      headers: { 'x-forge-token': server.token },
    });
    expect(res.status).toBe(400);
  });
});

describe('session message queue and delivery', () => {
  it('queues then drains, journaling chars only, never text', async () => {
    const queueRes = await fetch(`${base}/sessions/target-session/message`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'your PR conflicts with master', from: 'console' }),
    });
    expect(queueRes.status).toBe(200);

    const rawJournal = readFileSync(join(dir, 'fleet.jsonl'), 'utf8');
    expect(rawJournal).not.toContain('your PR conflicts with master');
    expect(rawJournal).toContain('"chars"');

    const inboxRes = await fetch(`${base}/sessions/target-session/inbox`, {
      headers: { 'x-forge-token': server.token },
    });
    const inboxBody = await inboxRes.json() as { messages: { from: string; text: string }[] };
    expect(inboxBody.messages).toHaveLength(1);
    expect(inboxBody.messages[0]?.text).toBe('your PR conflicts with master');

    const rawJournalAfterDrain = readFileSync(join(dir, 'fleet.jsonl'), 'utf8');
    expect(rawJournalAfterDrain).not.toContain('your PR conflicts with master');

    const drainedAgain = await fetch(`${base}/sessions/target-session/inbox`, {
      headers: { 'x-forge-token': server.token },
    });
    const drainedAgainBody = await drainedAgain.json() as { messages: unknown[] };
    expect(drainedAgainBody.messages).toHaveLength(0);
  });
});
