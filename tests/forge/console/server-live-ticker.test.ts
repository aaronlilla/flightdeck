/**
 * `ForgeServer`'s 2s liveness ticker (Aaron: "the second there's nothing working it
 * should stop... make sure it's visually accurate to what is actually happening").
 * Fires the tick directly through the test seam rather than waiting on a real
 * interval, and drives an injected `isAlive` by hand so a flip is deterministic --
 * `publish` is spied on rather than a real websocket client, the same seam
 * `server.publish` already gets in `tests/forge/server.test.ts`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { Registry } from '../../../src/forge/registry.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';

let server: ForgeServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

describe('ForgeServer liveness ticker', () => {
  it('publishes lane.live only on a flip, never while the process probe reads unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-live-ticker-'));
    process.env['FORGE_HOME'] = dir;
    const lanes = new Lanes(join(dir, 'lanes'));
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'beta', actor: 'runner' });
    journal.close();
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'beta', cwd: dir, briefPath: join(dir, 'beta.md'), pid: 9999 });

    let alive = true;
    server = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
      registry, port: 0, isAlive: () => alive,
    });
    await server.listen();

    const events: Array<Record<string, unknown>> = [];
    const originalPublish = server.publish.bind(server);
    server.publish = (event: Record<string, unknown>): void => { events.push(event); originalPublish(event); };
    const tick = (): void => (server as unknown as { tickLivenessForTest(): void }).tickLivenessForTest();

    tick(); // first sighting: establishes the baseline, no flip to report yet
    expect(events).toEqual([]);

    tick(); // unchanged (still alive): nothing published
    expect(events).toEqual([]);

    alive = false;
    tick(); // flip: alive -> dead
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'lane.live', run: 'beta', alive: false });

    events.length = 0;
    tick(); // unchanged (still dead): nothing published
    expect(events).toEqual([]);

    alive = true;
    tick(); // flip back: dead -> alive
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'lane.live', run: 'beta', alive: true });
  });
});
