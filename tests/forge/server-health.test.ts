import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { Registry } from '../../src/forge/registry.js';
import { Lanes } from '../../src/forge/supervisor.js';
import { ForgeServer } from '../../src/forge/server.js';

let dir: string;
let distDir: string;
let server: ForgeServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-server-health-'));
  distDir = join(dir, 'console-dist');
  mkdirSync(distDir, { recursive: true });
  process.env['FORGE_HOME'] = dir;
  const lanes = new Lanes(join(dir, 'lanes'));
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.close();
  const registry = new Registry(join(dir, 'registry'));

  server = new ForgeServer({
    lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'), registry, port: 0,
    consoleDistDir: distDir,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /state consoleBuilt fields', () => {
  it('reports checkoutDir, consoleDistDir and consoleBuilt: false with an empty dist dir', async () => {
    const res = await fetch(`${base}/state`);
    const body = await res.json() as Record<string, unknown>;
    expect(body['consoleDistDir']).toBe(distDir);
    expect(body['consoleBuilt']).toBe(false);
    expect(typeof body['checkoutDir']).toBe('string');
  });

  it('reports consoleBuilt: true once index.html exists', async () => {
    writeFileSync(join(distDir, 'index.html'), '<html></html>', 'utf8');
    const res = await fetch(`${base}/state`);
    const body = await res.json() as Record<string, unknown>;
    expect(body['consoleBuilt']).toBe(true);
  });
});

describe('GET /health', () => {
  it('answers 503 when the console is not built', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
  });

  it('answers 200 once index.html exists, with no token required', async () => {
    writeFileSync(join(distDir, 'index.html'), '<html></html>', 'utf8');
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});
