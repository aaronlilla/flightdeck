/**
 * `forge queue add` and `forge queue ls` -- the two commands that used to mean reading
 * `~/.forge/server-token` and curling `POST /queue` by hand, with the auth header guessed
 * wrong once (`Authorization: Bearer` instead of the `X-Forge-Token` the server actually
 * checks). Both wired through a real `ForgeServer` on an ephemeral port, the same way
 * `tests/forge/console/queue-route.test.ts` proves the route itself.
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
import { Lanes } from '../../src/forge/supervisor.js';

let home: string;
let server: ForgeServer | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-cli-queue-'));
  process.env['FORGE_HOME'] = home;
  mkdirSync(join(home, 'lanes'), { recursive: true });
  new Journal(join(home, 'fleet.jsonl')).close();
  delete process.env['FORGE_PORT'];
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  delete process.env['FORGE_PORT'];
});

async function startServer(): Promise<void> {
  const modelPolicyPath = join(home, 'model-policy.json');
  writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
  server = new ForgeServer({
    lanes: new Lanes(join(home, 'lanes')), inbox: new Inbox(join(home, 'inbox')),
    journalPath: join(home, 'fleet.jsonl'), port: 0, modelPolicyPath,
    queueStore: new QueueStore(join(home, 'queue.jsonl')),
  });
  const port = await server.listen();
  process.env['FORGE_PORT'] = String(port);
}

describe('forge queue add', () => {
  it('says the server is down when nothing is listening on the port', async () => {
    process.env['FORGE_PORT'] = '4121'; // nothing listens here in a test run
    const result = await forge(['queue', 'add', 'BBZ-178']);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('forge up is not running on 4120');
  });

  it('routes a ticket key to the ticket source with the correct auth header', async () => {
    await startServer();
    const result = await forge(['queue', 'add', 'BBZ-178']);
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toMatch(/queued/);
  });

  it('routes an existing file path to the brief source', async () => {
    await startServer();
    const briefPath = join(home, 'ok.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const result = await forge(['queue', 'add', briefPath]);
    expect(result.code).toBe(0);
  });

  it('refuses input that is neither a ticket key nor an existing file, with the exact reason', async () => {
    await startServer();
    const result = await forge(['queue', 'add', 'not a ticket or a file']);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('not a ticket key');
  });

  it('honors an explicit --source flag', async () => {
    await startServer();
    const briefPath = join(home, 'note.txt');
    writeFileSync(briefPath, 'some notes', 'utf8');
    const result = await forge(['queue', 'add', briefPath, '--source', 'brief']);
    expect(result.code).toBe(0);
  });
});

describe('forge queue ls', () => {
  it('lists queued items, hiding done by default', async () => {
    await startServer();
    await forge(['queue', 'add', 'BBZ-1']);
    await forge(['queue', 'add', 'BBZ-2']);
    const result = await forge(['queue', 'ls']);
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toMatch(/BBZ-1/);
    expect(result.lines.join('\n')).toMatch(/BBZ-2/);
  });

  it('filters by --state', async () => {
    await startServer();
    await forge(['queue', 'add', 'BBZ-1']);
    const result = await forge(['queue', 'ls', '--state', 'queued']);
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toMatch(/BBZ-1/);
    const noneResult = await forge(['queue', 'ls', '--state', 'done']);
    expect(noneResult.lines.join('\n')).not.toMatch(/BBZ-1/);
  });

  it('prints raw items as JSON with --json', async () => {
    await startServer();
    await forge(['queue', 'add', 'BBZ-1']);
    const result = await forge(['queue', 'ls', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.lines.join('\n')) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });

  it('says the server is down when nothing is listening', async () => {
    process.env['FORGE_PORT'] = '4121';
    const result = await forge(['queue', 'ls']);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('forge up is not running on 4120');
  });
});
