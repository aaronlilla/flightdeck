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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-sessions-view-'));
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

async function start(session: string, repo: string, worktree: string): Promise<void> {
  await fetch(`${base}/sessions/event`, {
    method: 'POST',
    headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'session.started', session, repo, worktree, cwd: worktree }),
  });
}

describe('GET /sessions same-repo marker', () => {
  it('marks two live sessions on one repo "may need to merge", and leaves a session on another repo alone', async () => {
    await start('s1', '/repos/example-mobile', '/repos/worktrees/example-mobile--a');
    await start('s2', '/repos/example-mobile', '/repos/worktrees/example-mobile--b');
    await start('s3', '/repos/flightdeck', '/repos/worktrees/flightdeck--one-ledger');

    const res = await fetch(`${base}/sessions?verbose=1`, { headers: { 'x-forge-token': server.token } });
    const body = await res.json() as { sessions: { sessionId: string; mayNeedToMerge?: boolean }[] };
    const byId = new Map(body.sessions.map((row) => [row.sessionId, row]));

    expect(byId.get('s1')?.mayNeedToMerge).toBe(true);
    expect(byId.get('s2')?.mayNeedToMerge).toBe(true);
    expect(byId.get('s3')?.mayNeedToMerge).toBeUndefined();
  });
});
