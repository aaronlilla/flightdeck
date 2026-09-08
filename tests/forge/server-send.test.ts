/**
 * `POST /send` used to write a run's inbox unconditionally and answer 200 even when
 * nothing would ever read the message. Aaron typed "kill and remove this" at the dead
 * lane `2026-09-04-forge-c2-rn` -- state `unverified`, `heart: false` -- and got a
 * silent "sent" with no reply and no error. This suite proves the fix: `/send` refuses
 * a target with no live session, whether the board has never heard of it or has a
 * record with no heart, and only a genuinely live chain gets the inbox write.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { Registry } from '../../src/forge/registry.js';
import { Lanes } from '../../src/forge/supervisor.js';
import { ForgeServer } from '../../src/forge/server.js';

let dir: string;
let server: ForgeServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-server-send-'));
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

function inboxFileCount(run: string): number {
  const runInboxDir = join(dir, 'runs', run, 'inbox');
  try {
    return readdirSync(runInboxDir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

async function postSend(run: string, text: string): Promise<Response> {
  return fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
    body: JSON.stringify({ run, text }),
  });
}

describe('POST /send refuses a target with no live session', () => {
  it('(a) a run with no record and no heart on the board -> 409, no inbox file written', async () => {
    const response = await postSend('ghost-run', 'kill and remove this');
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/no live session/);
    expect(inboxFileCount('ghost-run')).toBe(0);
  });

  it('(b) the incident shape: a registered lane, state unverified, heart false -> 409, no inbox file', async () => {
    // Mirrors the mission lane exactly: a `run.finished` row with an `unverified`
    // verdict and no live registry row, so the board carries a record but heart reads
    // false.
    // A lane file is what puts the record on the board at all: `lanesResponse`
    // enumerates lane ids off `lanes.all()`, so a journal-only run never appears and
    // would take the no-record path above instead of this one.
    new Lanes(join(dir, 'lanes')).put('2026-09-04-forge-c2-rn', { column: 'c', model: 'claude-sonnet-5', context: 1000, cost_usd: 0, session_id: 's1' });
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: '2026-09-04-forge-c2-rn', actor: 'runner' });
    journal.append({ event: 'run.finished', run: '2026-09-04-forge-c2-rn', verdict: 'unverified' });
    journal.close();
    const record = (await (await fetch(`${base}/lanes?all=1&archived=1`, { headers: { 'x-forge-token': server.token } })).json() as { lanes: Array<{ id: string; state: string; heart: boolean }> })
      .lanes.find((lane) => lane.id === '2026-09-04-forge-c2-rn');
    expect(record).toMatchObject({ state: 'unverified', heart: false });

    const response = await postSend('2026-09-04-forge-c2-rn', 'kill and remove this');

    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/2026-09-04-forge-c2-rn has no live session; it ended /);
    expect(inboxFileCount('2026-09-04-forge-c2-rn')).toBe(0);
  });

  it('(c) a chain whose newest link has a heart is live -> 200, the inbox file exists', async () => {
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('alpha', { column: 'c', model: 'claude-sonnet-5', context: 1000, cost_usd: 0, session_id: 's1' });
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });

    const liveServer = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), registry, port: 0,
    });
    const liveBase = `http://127.0.0.1:${await liveServer.listen()}`;
    try {
      const response = await fetch(`${liveBase}/send`, {
        method: 'POST',
        headers: { 'x-forge-token': liveServer.token, 'content-type': 'application/json' },
        body: JSON.stringify({ run: 'alpha', text: 'status?' }),
      });
      expect(response.status).toBe(200);
      expect(inboxFileCount('alpha')).toBe(1);
    } finally {
      await liveServer.close();
    }
  });
});
