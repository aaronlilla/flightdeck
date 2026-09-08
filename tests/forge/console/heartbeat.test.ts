/**
 * The `{type:'heartbeat', at}` frame `/events` pushes every `HEARTBEAT_MS` while a
 * client is connected -- the console model's own freshness contract depends on it, since
 * a value only reads as "verified" while a heartbeat under `VERIFIED_WINDOW_MS` keeps
 * arriving. `server.publish` is already proven to reach a real websocket frame
 * (`tests/forge/server.test.ts`'s own "pushes an event as a text frame" specimen); this
 * only has to prove the timer that calls it fires on schedule and stops on `close()`.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEARTBEAT_MS } from '../../../src/shared/console-model.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'console-heartbeat-'));
  mkdirSync(join(dir, 'lanes'), { recursive: true });
  process.env['FORGE_HOME'] = dir;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the heartbeat frame', () => {
  it('publishes every HEARTBEAT_MS while the server is listening', async () => {
    vi.useFakeTimers();
    const server = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0,
    });
    const published: Record<string, unknown>[] = [];
    const spy = vi.spyOn(server, 'publish').mockImplementation((event) => { published.push(event); });

    await server.listen();
    expect(published).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(published).toHaveLength(1);
    expect(published[0]!['type']).toBe('heartbeat');
    expect(typeof published[0]!['at']).toBe('number');

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(published).toHaveLength(3);

    spy.mockRestore();
    await server.close();
  });

  it('stops firing once the server is closed', async () => {
    vi.useFakeTimers();
    const server = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0,
    });
    const published: Record<string, unknown>[] = [];
    const spy = vi.spyOn(server, 'publish').mockImplementation((event) => { published.push(event); });

    await server.listen();
    await server.close();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(published).toHaveLength(0);
    spy.mockRestore();
  });
});

describe('the console rule-enforcement tick', () => {
  it('does not start until listen(), and stops on close(), the same lifecycle as the heartbeat', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const server = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0,
    });

    // Merely constructing a server (never listening) used to start the 10-second rule
    // tick anyway, since `ConsoleWrites`'s own constructor called `startEnforcementTick`
    // unconditionally -- a tick against a journal path that may never see a listen()
    // call, let alone a close() to stop it.
    expect(setIntervalSpy).not.toHaveBeenCalled();

    await server.listen();
    // One timer for the heartbeat, one for the rule-enforcement tick, one for the
    // console's own liveness ticker.
    expect(setIntervalSpy).toHaveBeenCalledTimes(3);

    await server.close();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
