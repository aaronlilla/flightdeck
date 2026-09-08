/**
 * `GET /queue`, `POST /queue`, `POST /queue/:id/remove`, `POST /queue/:id/retry`,
 * `POST /queue/pause`, `POST /queue/resume`, wired through a real `ForgeServer` the same
 * way `tests/forge/console/auth.test.ts` proves every other console route.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { QueueTicketSearch } from '../../../src/forge/intake/queue.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import type { ActionResult, QueueAddResponse, QueueResponse } from '../../../src/shared/console-model.js';

let dir: string;
let server: ForgeServer;
let base: string;
let queueStore: QueueStore;
let search: QueueTicketSearch;
const token = 'the-token';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'console-queue-'));
  mkdirSync(join(dir, 'lanes'), { recursive: true });
  process.env['FORGE_HOME'] = dir;
  new Journal(join(dir, 'fleet.jsonl')).close();
  const modelPolicyPath = join(dir, 'model-policy.json');
  writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
  queueStore = new QueueStore(join(dir, 'queue.jsonl'));
  search = { searchKeys: async () => ['ABC-1', 'ABC-2'] };
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), port: 0, token, modelPolicyPath,
    queueStore, queueSearch: search, queueMaxInFlight: 2,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
  delete process.env['FORGE_BACKLOG_PROJECT'];
});

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, 'x-forge-token': token } };
}

describe('GET /queue', () => {
  it('refuses a request with no token', async () => {
    const response = await fetch(`${base}/queue`);
    expect(response.status).toBe(401);
  });

  it('answers an empty queue with the configured concurrency', async () => {
    const response = await fetch(`${base}/queue`, authed());
    expect(response.status).toBe(200);
    const body = await response.json() as QueueResponse;
    expect(body).toEqual({ items: [], paused: false, maxInFlight: 2 });
  });
});

describe('POST /queue', () => {
  it('adds one item for a ticket key', async () => {
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ticket', input: 'ABC-1' }),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ source: 'ticket', ticket: 'ABC-1', state: 'queued' });

    const listed = await (await fetch(`${base}/queue`, authed())).json() as QueueResponse;
    expect(listed.items).toHaveLength(1);
  });

  it('adds one item for a pasted brief', async () => {
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'brief', input: '# Goal: fix the thing' }),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.items[0]).toMatchObject({ source: 'brief', ticket: null });
  });

  it('reads a pasted brief from a path when the input is a .md file on disk', async () => {
    const briefPath = join(dir, 'a-brief.md');
    writeFileSync(briefPath, ['# Goal: from a file', 'repo: owner/tools', ''].join('\n'), 'utf8');
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'brief', input: `  ${briefPath}  ` }),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.items[0]).toMatchObject({ source: 'brief', ticket: null });
    expect(body.items[0]!.input).toContain('# Goal: from a file');
  });

  it('refuses a ticket input that is not a key, without asking Jira', async () => {
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ticket', input: 'C:/somewhere/brief.md' }),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.ok).toBe(false);
    expect(body.items).toEqual([]);
    expect(body.error).toMatch(/ticket key/);
    expect(body.error).toMatch(/brief/);
  });

  it('adds one item per ticket a query resolves', async () => {
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'query', input: 'sprint = 42' }),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.items.map((i) => i.ticket)).toEqual(['ABC-1', 'ABC-2']);
  });

  it('A.5: wraps a backlog filter into project-scoped JQL before the search ever sees it', async () => {
    process.env['FORGE_BACKLOG_PROJECT'] = 'BB';
    const jqlSeen: string[] = [];
    await server.close();
    server = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0, token,
      modelPolicyPath: join(dir, 'model-policy.json'), queueStore,
      queueSearch: { searchKeys: async (jql) => { jqlSeen.push(jql); return ['ABC-1']; } },
    });
    base = `http://127.0.0.1:${await server.listen()}`;

    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'backlog', input: 'flaky' }),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.ok).toBe(true);
    expect(jqlSeen).toEqual(['project = BB AND statusCategory != Done AND text ~ "flaky"']);
    delete process.env['FORGE_BACKLOG_PROJECT'];
  });

  it('reports a missing Jira credential by name rather than adding nothing silently', async () => {
    process.env['FORGE_BACKLOG_PROJECT'] = 'BB'; // clears the backlog-JQL wrapper (A.5) so the Jira check is what's exercised here
    await server.close();
    server = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0, token,
      modelPolicyPath: join(dir, 'model-policy.json'), queueStore,
      // No queueSearch override: the server's own default refuses.
    });
    base = `http://127.0.0.1:${await server.listen()}`;

    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'backlog', input: 'project = BB' }),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toContain('FORGE_JIRA_SITE');
  });

  it('refuses a body missing source or input', async () => {
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    }));
    const body = await response.json() as QueueAddResponse;
    expect(body.ok).toBe(false);
  });
});

describe('POST /queue/:id/remove and /retry', () => {
  it('removes an item, then 404s removing it again', async () => {
    const added = await (await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ticket', input: 'ABC-1' }),
    }))).json() as QueueAddResponse;
    const id = added.items[0]!.id;

    const removed = await fetch(`${base}/queue/${id}/remove`, authed({ method: 'POST' }));
    expect(removed.status).toBe(200);

    const again = await fetch(`${base}/queue/${id}/remove`, authed({ method: 'POST' }));
    expect(again.status).toBe(404);
  });

  it('refuses to retry an item that is not parked or failed', async () => {
    const added = await (await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ticket', input: 'ABC-1' }),
    }))).json() as QueueAddResponse;
    const id = added.items[0]!.id;

    const retried = await fetch(`${base}/queue/${id}/retry`, authed({ method: 'POST' }));
    expect(retried.status).toBe(409);
  });
});

describe('POST /queue/:id/merge and /promote: A.7', () => {
  it('501s a merge when this environment has no merge wiring configured', async () => {
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ticket', input: 'ABC-1' }),
    }));
    const added = await response.json() as QueueAddResponse;
    const id = added.items[0]!.id;

    const merge = await fetch(`${base}/queue/${id}/merge`, authed({ method: 'POST' }));
    expect(merge.status).toBe(501);
    const body = await merge.json() as ActionResult;
    expect(body.message).toContain('no merge wiring');
  });

  it('501s a promote when this environment has no production publish wiring configured', async () => {
    const response = await fetch(`${base}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'hotfix', input: 'login crashes' }),
    }));
    const added = await response.json() as QueueAddResponse;
    const id = added.items[0]!.id;

    const promote = await fetch(`${base}/queue/${id}/promote`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '1.0.0', message: 'x' }),
    }));
    expect(promote.status).toBe(501);
    const body = await promote.json() as ActionResult;
    expect(body.message).toContain('no production publish wiring');
  });

  it('404s a merge for an id the queue has never seen', async () => {
    const merge = await fetch(`${base}/queue/nope/merge`, authed({ method: 'POST' }));
    expect(merge.status).toBe(404);
  });
});

// Sweep #4: the real Promote click posted `{}` while this route always required
// `{version, message}`, so it 400ed on every click in production; only a 501-wiring
// specimen ever exercised this route before. A server with promote wiring configured
// proves both the 400 refusal and that a successful promote is recorded on the item.
describe('POST /queue/:id/promote with wiring configured: sweep #4', () => {
  let wiredServer: ForgeServer;
  let wiredBase: string;
  let wiredStore: QueueStore;

  beforeEach(async () => {
    wiredStore = new QueueStore(join(dir, 'queue-wired.jsonl'));
    wiredServer = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0, token, modelPolicyPath: join(dir, 'model-policy.json'),
      queueStore: wiredStore, queueSearch: search, queueMaxInFlight: 2,
      queuePromoteDeps: { productionWorkflowExists: async () => true, promote: async () => undefined },
    });
    wiredBase = `http://127.0.0.1:${await wiredServer.listen()}`;
  });

  afterEach(async () => {
    await wiredServer.close();
  });

  async function addDoneHotfix(): Promise<string> {
    const response = await fetch(`${wiredBase}/queue`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'hotfix', input: 'login crashes' }),
    }));
    const added = await response.json() as QueueAddResponse;
    const id = added.items[0]!.id;
    wiredStore.append({ id, at: Date.now(), state: 'done', updatedAt: Date.now() });
    return id;
  }

  it('refuses an empty-body promote with 400, the same way the server does', async () => {
    const id = await addDoneHotfix();
    const promote = await fetch(`${wiredBase}/queue/${id}/promote`, authed({ method: 'POST' }));
    expect(promote.status).toBe(400);
    const body = await promote.json() as ActionResult;
    expect(body.message).toBe('a promote needs a version and a message');
  });

  it('records promotedAt/promotedVersion on a successful promote', async () => {
    const id = await addDoneHotfix();
    const promote = await fetch(`${wiredBase}/queue/${id}/promote`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '1.4.2', message: 'hotfix release' }),
    }));
    expect(promote.status).toBe(200);
    const items = wiredStore.all();
    const item = items.find((i) => i.id === id);
    expect(item?.promotedVersion).toBe('1.4.2');
    expect(item?.promotedAt).toBeGreaterThan(0);
  });
});

describe('POST /queue/pause and /resume', () => {
  it('flips the paused flag GET /queue reports', async () => {
    const paused = await fetch(`${base}/queue/pause`, authed({ method: 'POST' }));
    expect(paused.status).toBe(200);
    const afterPause = await (await fetch(`${base}/queue`, authed())).json() as QueueResponse;
    expect(afterPause.paused).toBe(true);

    const resumed = await fetch(`${base}/queue/resume`, authed({ method: 'POST' }));
    expect(resumed.status).toBe(200);
    const afterResume = await (await fetch(`${base}/queue`, authed())).json() as QueueResponse;
    expect(afterResume.paused).toBe(false);
  });
});
