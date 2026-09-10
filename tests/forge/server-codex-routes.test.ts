/**
 * R-55: `POST /codex/ask` and `GET /codex/:id` sit behind the same token every other
 * write route does -- a real test server, a fake advisor (never spawns Codex), one
 * request with the token and one without.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../src/forge/inbox.js';
import { Registry } from '../../src/forge/registry.js';
import { ForgeServer } from '../../src/forge/server.js';
import { Lanes } from '../../src/forge/supervisor.js';
import type { CodexAdvisor } from '../../src/forge/council/codexAdvisor.js';

let dir: string;
let server: ForgeServer;
let base: string;

const fakeAdvisor = {
  ask: async (input: { prompt: string; cwd: string; label: string; model?: string }) => (
    { id: `run-for-${input.label}` }
  ),
  status: async (id: string) => ({ state: 'running', id } as unknown as { state: string; exitCode?: number }),
  result: async () => ({ exitCode: 0 }),
} as unknown as CodexAdvisor;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-codex-route-'));
  writeFileSync(join(dir, 'model-policy.json'), JSON.stringify({ classes: {}, aliases: {} }));
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), registry: new Registry(join(dir, 'registry')),
    forgeHomeDir: dir, port: 0, codexAdvisor: fakeAdvisor,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
});

describe('POST /codex/ask', () => {
  it('401s without the token', async () => {
    const response = await fetch(`${base}/codex/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'is this safe?', cwd: dir, label: 'safety' }),
    });
    expect(response.status).toBe(401);
  });

  it('returns an id with the token', async () => {
    const response = await fetch(`${base}/codex/ask`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'is this safe?', cwd: dir, label: 'safety' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string };
    expect(body.id).toBe('run-for-safety');
  });
});

describe('GET /codex/:id', () => {
  it('401s without the token', async () => {
    const response = await fetch(`${base}/codex/run-for-safety`);
    expect(response.status).toBe(401);
  });

  it('answers with the token', async () => {
    const response = await fetch(`${base}/codex/run-for-safety`, {
      headers: { 'x-forge-token': server.token },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { state: string };
    expect(body.state).toBe('running');
  });
});
