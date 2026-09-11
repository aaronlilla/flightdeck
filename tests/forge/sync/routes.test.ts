/**
 * R-68 item 6: `GET /sync`, `POST /sync/full`, `POST /sync/:scope`, `POST /watcher/on|off`,
 * on an ephemeral `ForgeServer` -- never the live console on 4120.
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
import { SyncStore } from '../../../src/forge/sync/store.js';
import type { SyncStageFn } from '../../../src/forge/sync/run.js';
import { JiraWatcher } from '../../../src/forge/sync/watcher-state.js';
import type { SyncStageName } from '../../../src/shared/sync-contract.js';

let dir: string;
let server: ForgeServer;
let base: string;
let syncPath: string;
let release: (() => void) | undefined;

const FULL_ORDER: SyncStageName[] = [
  'stop-workers', 'wipe-queue', 'reset-watermarks',
  'fetch-repos', 'reconcile-prs', 'sweep-worktrees',
  'pull-jira', 'watcher-on', 'resume',
];

function okStage(): SyncStageFn {
  return async () => ({ counts: {} });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-sync-routes-'));
  process.env['FORGE_HOME'] = dir;
  delete process.env['FORGE_JIRA_SITE'];
  delete process.env['FORGE_JIRA_EMAIL'];
  delete process.env['FORGE_JIRA_TOKEN'];
  const lanes = new Lanes(join(dir, 'lanes'));
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.close();
  const registry = new Registry(join(dir, 'registry'));

  syncPath = join(dir, 'console', 'sync.json');
  const store = new SyncStore(syncPath);
  const stages: Record<string, SyncStageFn> = Object.fromEntries(FULL_ORDER.map((name) => [name, okStage()]));
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // `stop-workers` blocks on `gate` so a test can observe a run mid-flight (409 while
  // running) before letting it finish.
  stages['stop-workers'] = async () => { await gate; return { counts: {} }; };
  const watcher = new JiraWatcher({
    jiraConfig: () => undefined, watermarks: { get: () => ({ source: 'jira', committedAt: 0, idsAtCommittedAt: [] }), set: () => {} },
    store: undefined as never, journal: new Journal(join(dir, 'fleet.jsonl')),
  });

  server = new ForgeServer({
    lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'), registry, port: 0,
    syncStore: store, syncDeps: { stages, journal: new Journal(join(dir, 'fleet.jsonl')), store }, watcher,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  release?.();
  await server.close();
});

describe('GET /sync', () => {
  it('401s with no token', async () => {
    const res = await fetch(`${base}/sync`);
    expect(res.status).toBe(401);
  });

  it('returns runs and watcher status', async () => {
    const res = await fetch(`${base}/sync`, { headers: { 'x-forge-token': server.token } });
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Record<string, unknown>; watcher: { on: boolean } };
    expect(body.runs.full).toBeNull();
    expect(body.watcher.on).toBe(false);
  });
});

describe('POST /sync/full', () => {
  it('401s with no token', async () => {
    const res = await fetch(`${base}/sync/full`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('unconfirmed returns the confirm-gate pending shape', async () => {
    const res = await fetch(`${base}/sync/full`, {
      method: 'POST', headers: { 'x-forge-token': server.token, 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { ok: boolean; pending: boolean; token: string };
    expect(body.pending).toBe(true);
    expect(body.ok).toBe(false);
    expect(typeof body.token).toBe('string');
    release?.();
  });

  it('names live queue and worker counts in the confirm blast text', async () => {
    await fetch(`${base}/queue`, {
      method: 'POST', headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ticket', input: 'BBZ-1' }),
    });

    const res = await fetch(`${base}/sync/full`, {
      method: 'POST', headers: { 'x-forge-token': server.token, 'content-type': 'application/json' }, body: '{}',
    });
    const body = await res.json() as { blast: string };
    expect(body.blast).toContain('wipe 1 queue items');
    expect(body.blast).toContain('stop 0 running workers');
    expect(body.blast).toContain('worktree sweep: remove 0 stale worktrees');
    release?.();
  });

  it('confirmed runs the sync and journals sync.started', async () => {
    const first = await fetch(`${base}/sync/full`, {
      method: 'POST', headers: { 'x-forge-token': server.token, 'content-type': 'application/json' }, body: '{}',
    });
    const { token } = await first.json() as { token: string };

    const confirmed = fetch(`${base}/sync/full`, {
      method: 'POST', headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: token }),
    });

    // While stop-workers is gated open, a second full is refused with 409.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await fetch(`${base}/sync/full`, {
      method: 'POST', headers: { 'x-forge-token': server.token, 'content-type': 'application/json' }, body: '{}',
    });
    expect(second.status).toBe(409);

    release?.();
    const confirmedRes = await confirmed;
    expect(confirmedRes.status).toBe(202);
    const confirmedBody = await confirmedRes.json() as { started: boolean; id: string };
    expect(confirmedBody.started).toBe(true);

    const journalLines = readFileSync(join(dir, 'fleet.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    expect(journalLines.some((line) => line.includes('"event":"sync.started"'))).toBe(true);
  });
});

describe('/state.watcher', () => {
  it('flips after POST /watcher/on and /watcher/off', async () => {
    const before = await fetch(`${base}/state`);
    const beforeBody = await before.json() as { watcher: { on: boolean } };
    expect(beforeBody.watcher.on).toBe(false);

    const on = await fetch(`${base}/watcher/on`, {
      method: 'POST', headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'BBZ' }),
    });
    expect(on.status).toBe(200);

    const afterOn = await fetch(`${base}/state`);
    const afterOnBody = await afterOn.json() as { watcher: { on: boolean; project: string | null } };
    expect(afterOnBody.watcher.on).toBe(true);
    expect(afterOnBody.watcher.project).toBe('BBZ');

    await fetch(`${base}/watcher/off`, { method: 'POST', headers: { 'x-forge-token': server.token } });
    const afterOff = await fetch(`${base}/state`);
    const afterOffBody = await afterOff.json() as { watcher: { on: boolean } };
    expect(afterOffBody.watcher.on).toBe(false);
  });
});
