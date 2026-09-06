/**
 * The console's read routes require the same `X-Forge-Token` bearer every write on this
 * server already does -- `/state` is the one open read, and none of these are it.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';

let dir: string;
let server: ForgeServer;
let base: string;
const token = 'the-token';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'console-auth-'));
  mkdirSync(join(dir, 'lanes'), { recursive: true });
  process.env['FORGE_HOME'] = dir;
  new Journal(join(dir, 'fleet.jsonl')).close();
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), port: 0, token,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
});

describe.each(['/lanes', '/thread', '/journal', '/caps', '/proposals'])('%s', (path) => {
  it('refuses a request with no token', async () => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(401);
  });

  it('answers with the right token', async () => {
    const response = await fetch(`${base}${path}`, { headers: { 'x-forge-token': token } });
    expect(response.status).toBe(200);
  });
});
