/**
 * R-53: under `FORGE_LOGIN_HELPER=1`, `POST /accounts/connect` must emit
 * `accounts.connect-requested` on the live stream instead of spawning `claude auth
 * login` in-process -- a service in Session 0 has no browser to hand that process. The
 * detector: no real `child_process.spawn` reaches the login command, ever.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Inbox } from '../../src/forge/inbox.js';
import { Registry } from '../../src/forge/registry.js';
import { ForgeServer } from '../../src/forge/server.js';
import { Lanes } from '../../src/forge/supervisor.js';

let dir: string;
let server: ForgeServer;
let base: string;
let published: Array<Record<string, unknown>>;
const originalFlag = process.env['FORGE_LOGIN_HELPER'];

beforeEach(async () => {
  process.env['FORGE_LOGIN_HELPER'] = '1';
  dir = mkdtempSync(join(tmpdir(), 'forge-login-helper-route-'));
  writeFileSync(join(dir, 'model-policy.json'), JSON.stringify({ classes: {}, aliases: {} }));
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), registry: new Registry(join(dir, 'registry')),
    forgeHomeDir: dir, port: 0,
  });
  published = [];
  vi.spyOn(server, 'publish').mockImplementation((event) => { published.push(event as Record<string, unknown>); });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
  if (originalFlag === undefined) delete process.env['FORGE_LOGIN_HELPER'];
  else process.env['FORGE_LOGIN_HELPER'] = originalFlag;
});

describe('POST /accounts/connect under FORGE_LOGIN_HELPER=1', () => {
  it('publishes accounts.connect-requested instead of spawning the login in-process', async () => {
    const response = await fetch(`${base}/accounts/connect`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(response.status).toBe(200);
    // Give runConnect's async chain one tick to reach spawnLogin.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const connectRequested = published.find((event) => event['event'] === 'accounts.connect-requested');
    expect(connectRequested).toBeDefined();
    expect(connectRequested?.['provider']).toBe('claude');
    expect(typeof connectRequested?.['configDir']).toBe('string');
    expect(String(connectRequested?.['configDir']).length).toBeGreaterThan(0);
  });
});
