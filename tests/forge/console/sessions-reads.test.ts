import { mkdtempSync } from 'node:fs';
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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-sessions-reads-'));
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

describe('GET /sessions', () => {
  it('has no session id and no pid in the plain-English default view', async () => {
    await fetch(`${base}/sessions/event`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'session.started', session: '4f6b1c7e-88aa-4bcd-9e12-abcdef012345', pid: 4242, cwd: '/repos/worktrees/flightdeck--one-ledger' }),
    });

    const res = await fetch(`${base}/sessions`, { headers: { 'x-forge-token': server.token } });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toMatch(UUID_RE);
    expect(bodyText).not.toContain('4242');
    expect(bodyText).toContain('/repos/worktrees/flightdeck--one-ledger');

    const verboseRes = await fetch(`${base}/sessions?verbose=1`, { headers: { 'x-forge-token': server.token } });
    const verboseText = await verboseRes.text();
    expect(verboseText).toMatch(UUID_RE);
  });
});
