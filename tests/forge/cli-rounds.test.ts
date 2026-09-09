/**
 * `forge rounds` against a real server: the dry run prints the sheet and changes
 * nothing, `--apply` acts through the queue, and a route that does not answer inside
 * the ceiling is reported as a timeout, never as "not running".
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forge } from '../../src/forge/cli.js';
import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { QueueStore } from '../../src/forge/intake/queueStore.js';
import { ForgeServer } from '../../src/forge/server.js';
import { serverRequest } from '../../src/forge/server-request.js';
import { Lanes } from '../../src/forge/supervisor.js';

let home: string;
let server: ForgeServer | undefined;
let store: QueueStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-cli-rounds-'));
  process.env['FORGE_HOME'] = home;
  mkdirSync(join(home, 'lanes'), { recursive: true });
  new Journal(join(home, 'fleet.jsonl')).close();
  delete process.env['FORGE_PORT'];
  delete process.env['FORGE_REQUEST_TIMEOUT_MS'];
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  delete process.env['FORGE_PORT'];
  delete process.env['FORGE_REQUEST_TIMEOUT_MS'];
});

async function startServer(): Promise<void> {
  const modelPolicyPath = join(home, 'model-policy.json');
  writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
  store = new QueueStore(join(home, 'queue.jsonl'));
  store.append({ id: 'q1', at: 1, source: 'ticket', input: 'ACME-1', ticket: 'ACME-1', state: 'parked', reason: 'parked', createdAt: 1, updatedAt: 1 } as never);
  server = new ForgeServer({
    lanes: new Lanes(join(home, 'lanes')), inbox: new Inbox(join(home, 'inbox')),
    journalPath: join(home, 'fleet.jsonl'), port: 0, modelPolicyPath, queueStore: store,
    blockersGather: async () => ({ now: Date.now(), asks: [], integrations: [], lanes: [], billing: [], registryLive: new Set<string>() }),
  });
  const port = await server.listen();
  process.env['FORGE_PORT'] = String(port);
}

describe('forge rounds', () => {
  it('prints the dry-run sheet and leaves the queue alone', async () => {
    await startServer();
    const result = await forge(['rounds']);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/^Rounds \(dry run, nothing changed\): 1 finding/);
    expect(result.lines.join('\n')).toContain('ACME-1 [q1]: parked');
    expect(store.get('q1')!.state).toBe('parked');
  });

  it('--apply acts through the queue and says what it did', async () => {
    await startServer();
    const result = await forge(['rounds', '--apply']);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/^Rounds \(applied\)/);
    expect(store.get('q1')!.state).toBe('queued');
  });

  it('a route that does not answer inside the ceiling is a timeout, not a missing server', async () => {
    await startServer();
    process.env['FORGE_REQUEST_TIMEOUT_MS'] = '20';
    const hang: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const result = await forge(['rounds'], { fetchFn: hang });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toBe('forge up did not answer /rounds in 0s');
    expect(result.lines.join('\n')).not.toContain('not running');
  });
});

describe('serverRequest', () => {
  it('still reports a refused connection as the server not running', async () => {
    process.env['FORGE_PORT'] = '4121';
    writeFileSync(join(home, 'server-token'), 'tok', 'utf8');
    const result = await serverRequest('/state');
    expect(result).toMatchObject({ ok: false, down: true, error: 'forge up is not running on 4120' });
  });
});
