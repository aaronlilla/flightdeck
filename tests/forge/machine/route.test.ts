/**
 * `GET /machine` and the Machine ticker: one process-table read per tick, one
 * `machine` slice event only when the pid set or a command line changed, an
 * unauthenticated request refused the same way every other read is, and nothing
 * further read or published once the server has shut down.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { Registry } from '../../../src/forge/registry.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import type { ProcessRow } from '../../../src/forge/sweep.js';

let server: ForgeServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  vi.useRealTimers();
});

function setup(processTable: () => ProcessRow[]): { dir: string; base: Promise<string> } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-machine-route-'));
  process.env['FORGE_HOME'] = dir;
  const lanes = new Lanes(join(dir, 'lanes'));
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.close();
  const registry = new Registry(join(dir, 'registry'));
  server = new ForgeServer({
    lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
    registry, port: 0, processTable,
  });
  const base = server.listen().then((port) => `http://127.0.0.1:${port}`);
  return { dir, base };
}

describe('GET /machine', () => {
  it('is authorized like every other read', async () => {
    const { base } = setup(() => []);
    const res = await fetch(`${await base}/machine`);
    expect(res.status).not.toBe(200);
  });

  it('returns the glance sentence and snapshot for an authorized request', async () => {
    const { base } = setup(() => []);
    const url = await base;
    const res = await fetch(`${url}/machine`, { headers: { 'x-forge-token': (server as ForgeServer).token } });
    expect(res.status).toBe(200);
    const body = await res.json() as { glance: string; sessions: unknown[]; unregistered: unknown[] };
    expect(body.glance).toMatch(/sessions.*processes.*unregistered/);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(Array.isArray(body.unregistered)).toBe(true);
  });
});

describe('Machine ticker', () => {
  it('publishes machine exactly once per real change, and zero times for an unchanged read', () => {
    let rows: ProcessRow[] = [{ pid: 100, ppid: 1, name: 'claude.exe', ageMs: 1000 }];
    const dir = mkdtempSync(join(tmpdir(), 'forge-machine-ticker-'));
    process.env['FORGE_HOME'] = dir;
    const lanes = new Lanes(join(dir, 'lanes'));
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.close();
    const registry = new Registry(join(dir, 'registry'));
    server = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
      registry, port: 0, processTable: () => rows,
    });
    const events: Array<Record<string, unknown>> = [];
    const originalPublish = server.publish.bind(server);
    server.publish = (event: Record<string, unknown>): void => { events.push(event); originalPublish(event); };
    const tick = (): void => (server as unknown as { tickMachineForTest(): void }).tickMachineForTest();

    tick(); // first read: establishes the signature
    const machineEvents = (): Array<Record<string, unknown>> => events.filter((e) => e['slice'] === 'machine');
    expect(machineEvents()).toHaveLength(1); // the first read is always "new" relative to no prior signature

    events.length = 0;
    tick(); // unchanged process table: nothing published
    expect(machineEvents()).toHaveLength(0);

    events.length = 0;
    tick(); // still unchanged: still nothing
    expect(machineEvents()).toHaveLength(0);

    rows = [...rows, { pid: 101, ppid: 100, name: 'node.exe', ageMs: 500 }];
    events.length = 0;
    tick(); // a new child pid: exactly one publish
    expect(machineEvents()).toHaveLength(1);
  });

  it('reads and publishes nothing after shutdown', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const dir = mkdtempSync(join(tmpdir(), 'forge-machine-shutdown-'));
    process.env['FORGE_HOME'] = dir;
    const lanes = new Lanes(join(dir, 'lanes'));
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.close();
    const registry = new Registry(join(dir, 'registry'));
    server = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
      registry, port: 0, machineTickMs: 100,
      processTable: () => { calls += 1; return []; },
    });
    await server.listen();
    await vi.advanceTimersByTimeAsync(250); // at least two intervals while running
    const callsWhileLive = calls;
    expect(callsWhileLive).toBeGreaterThan(0);

    await server.close();
    server = undefined;
    await vi.advanceTimersByTimeAsync(250); // at least two more intervals after shutdown
    expect(calls).toBe(callsWhileLive); // not one further read
  });

  it('never crashes the tick when the process-table read throws (2026-09-10 CI: no powershell on the runner)', () => {
    const { dir, base } = (() => {
      const d = mkdtempSync(join(tmpdir(), 'forge-machine-throw-'));
      process.env['FORGE_HOME'] = d;
      const lanes = new Lanes(join(d, 'lanes'));
      const journal = new Journal(join(d, 'fleet.jsonl'));
      journal.close();
      const registry = new Registry(join(d, 'registry'));
      server = new ForgeServer({
        lanes, inbox: new Inbox(join(d, 'inbox')), journalPath: join(d, 'fleet.jsonl'),
        registry, port: 0,
        processTable: () => { throw new Error('spawnSync powershell ENOENT'); },
      });
      return { dir: d, base: server.listen().then((p) => `http://127.0.0.1:${p}`) };
    })();
    void dir;
    const tick = (): void => (server as unknown as { tickMachineForTest(): void }).tickMachineForTest();
    expect(() => tick()).not.toThrow();
    return base.then(async (url) => {
      const res = await fetch(`${url}/machine`, { headers: { 'x-forge-token': (server as ForgeServer).token } });
      expect(res.status).toBe(200);
      const body = await res.json() as { glance: string };
      expect(body.glance).toContain('0 sessions');
    });
  });
});
