/**
 * The runner's HTTP and websocket surface on port 4120.
 *
 * Four routes and one stream. `/state` is what a board draws, `/inbox` is what is waiting
 * on a person, `/answer` is how that person replies, and `/events` pushes as things
 * happen so nothing has to poll. The old dashboard polled files on a timer and showed no
 * model, no context and no cost; those three are the point of `/state`.
 *
 * Bound to loopback. This serves the fleet's state and takes answers that resume runs, so
 * a wrong bind address is a control surface on the network.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { categoryOf } from '../../src/console/laneState.js';
import type { LaneRecord } from '../../src/console/types.js';
import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { Registry } from '../../src/forge/registry.js';
import { RunInbox } from '../../src/forge/runinbox.js';
import { Breaker, readKillSwitch, Lanes } from '../../src/forge/supervisor.js';
import { ForgeServer, FORGE_PORT } from '../../src/forge/server.js';
import { fetchConfirmed } from '../helpers/confirmed.js';
import { ConsoleReads } from '../../src/forge/console/reads.js';

let dir: string;
let server: ForgeServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forge-server-'));
  // ensureServerToken() falls back to serverTokenPath(), which resolves through
  // forgeHome(): without this every specimen here would mint (or read) a token from this
  // machine's real ~/.forge rather than the test's own temp directory.
  process.env['FORGE_HOME'] = dir;
  const lanes = new Lanes(join(dir, 'lanes'));
  lanes.put('alpha', {
    column: 'c', model: 'claude-sonnet-5', context: 42_000, cost_usd: 1.25,
    session_id: 's1',
  });
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
  journal.close();

  // P4.7/I8: `/stop` selects targets from the registry's live rows, never from lane
  // records, so a run this test wants treated as live needs an admitted row backed by
  // this process's own (genuinely alive) pid.
  const registry = new Registry(join(dir, 'registry'));
  registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });

  server = new ForgeServer({
    lanes,
    inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'),
    registry,
    port: 0,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterEach(async () => {
  await server.close();
});

describe('the port', () => {
  it('is 4120 by default', () => {
    expect(FORGE_PORT).toBe(4120);
  });

  it('binds loopback, not every interface', () => {
    expect(server.host).toBe('127.0.0.1');
  });
});

interface Wrapped<T> {
  value: T;
  verified_at: number;
}

describe('GET /state', () => {
  it('returns the lanes with model, context and cost', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const lanes = (state['lanes'] as Wrapped<Record<string, unknown>[]>).value;
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.['model']).toBe('claude-sonnet-5');
    expect(lanes[0]?.['context']).toBe(42_000);
    expect(lanes[0]?.['cost_usd']).toBe(1.25);
  });

  it('reports dollars per hour per lane, which no board could show before', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const lanes = (state['lanes'] as Wrapped<Record<string, unknown>[]>).value;
    expect(lanes[0]).toHaveProperty('usd_per_hour');
  });

  it('holds usd_per_hour at 0 for a run under five minutes old, rather than extrapolating', async () => {
    // Item 3, 2026-09-05: a three-minute-old probe that had spent $3.06 was shown as
    // $61.11/h -- the old threshold zeroed out only the first 30 seconds, so anything
    // past that got divided by a fraction of an hour and produced a rate with no
    // resemblance to what the run would actually cost across a real hour.
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('probe', {
      column: 'c', model: 'claude-sonnet-5', context: 1_000, cost_usd: 3.0555,
      started: Date.now() - 3 * 60_000, session_id: 's2',
    });
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const lanesOut = (state['lanes'] as Wrapped<Record<string, unknown>[]>).value;
    const probe = lanesOut.find((lane) => lane['slug'] === 'probe');
    expect(probe?.['usd_per_hour']).toBe(0);
  });

  it('carries the fleet burn per tier from the journal', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    expect(state).toHaveProperty('burn');
    expect(state['burn']).toHaveProperty('value');
    expect(state['burn']).toHaveProperty('verified_at');
  });

  it('answers JSON with a content type a browser will parse', async () => {
    const response = await fetch(`${base}/state`);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('carries per-run last_event_age_s and current_tool on each lane', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const lanes = (state['lanes'] as Wrapped<Record<string, unknown>[]>).value;
    expect(lanes[0]).toHaveProperty('last_event_age_s');
    expect(lanes[0]).toHaveProperty('current_tool');
  });

  it('carries a stuck list and a fleet section', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    expect(state['stuck']).toHaveProperty('value');
    expect(state['fleet']).toHaveProperty('value');
  });

  it('I11: runs lists a real, registered run but never a warden.parked row for a fleet pid', async () => {
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    // A `warden.parked` row a pre-fix Warden tick wrote for a fleet process id, never a
    // registered run -- this is exactly what folded into `fleet.runs['pid:1234']` before
    // I11 and surfaced on the board as a phantom parked run.
    journal.append({ event: 'warden.parked', run: 'pid:1234', actor: 'warden', signal: 'stale-session' });
    journal.close();

    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const runs = state['runs'] as Record<string, unknown>;
    expect(runs).toHaveProperty('alpha');
    expect(runs).not.toHaveProperty('pid:1234');
  });

  it('B.3.6 sentence 1: stuck and fleet carry observed_at, not verified_at -- neither is backed by a source read', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    expect(state['stuck']).toHaveProperty('observed_at');
    expect(state['stuck']).not.toHaveProperty('verified_at');
    expect(state['fleet']).toHaveProperty('observed_at');
    expect(state['fleet']).not.toHaveProperty('verified_at');
  });

  it('B.3.6 sentence 1: burn, handoffs and torn carry verified_at from the journal file\'s own mtime', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const burn = state['burn'] as { verified_at: number };
    // Read fresh from the file the journal actually is, not from Date.now() at request
    // time: the falsifier this closes is a verified_at that only ever equals "now".
    const mtime = statSync(join(dir, 'fleet.jsonl')).mtimeMs;
    expect(burn.verified_at).toBe(mtime);
  });

  it('B.3.9: a second /state read only parses the bytes appended since the first', async () => {
    let bytesRead = 0;
    const countingReader = {
      size: (path: string) => statSync(path).size,
      readRange: (path: string, start: number, end: number) => {
        bytesRead += end - start;
        return readFileSync(path, 'utf8').slice(start, end);
      },
    };
    const journalPath = join(dir, 'fleet.jsonl');
    for (let index = 0; index < 50; index += 1) {
      new Journal(journalPath).append({ event: 'turn.end', run: 'alpha', actor: 'worker', context: index });
    }
    const countingServer = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath, port: 0, journalRangeReader: countingReader,
    });
    const countingBase = `http://127.0.0.1:${await countingServer.listen()}`;
    try {
      await fetch(`${countingBase}/state`);
      const afterFirst = bytesRead;
      expect(afterFirst).toBeGreaterThan(0);

      new Journal(journalPath).append({ event: 'turn.end', run: 'alpha', actor: 'worker', context: 999 });
      await fetch(`${countingBase}/state`);
      const onSecondRead = bytesRead - afterFirst;
      expect(onSecondRead).toBeGreaterThan(0);
      expect(onSecondRead).toBeLessThan(afterFirst / 10);
    } finally {
      await countingServer.close();
    }
  });

  it('B.3.9 code review: a caller-supplied JournalCache is the one /state actually reads '
    + 'from, so a liveness tick sharing it with the server pays for one fold, not two', async () => {
    const journalPath = join(dir, 'fleet-shared.jsonl');
    new Journal(journalPath).append({ event: 'turn.end', run: 'alpha', actor: 'worker', context: 1 });

    const { JournalCache } = await import('../../src/forge/journal.js');
    const sharedCache = new JournalCache();
    // Priming the shared cache directly, the way cli.ts's liveness tick would between
    // ticks: if the server built its own cache instead of using this one, its first read
    // would still have to fold from byte zero and this assertion would fail.
    sharedCache.read(journalPath);
    let readCalls = 0;
    const originalRead = sharedCache.read.bind(sharedCache);
    sharedCache.read = (path: string) => { readCalls += 1; return originalRead(path); };

    const sharedServer = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes-shared')), inbox: new Inbox(join(dir, 'inbox-shared')),
      journalPath, port: 0, journalCache: sharedCache,
    });
    const sharedBase = `http://127.0.0.1:${await sharedServer.listen()}`;
    try {
      await fetch(`${sharedBase}/state`);
      expect(readCalls).toBe(1);
    } finally {
      await sharedServer.close();
    }
  });

  it('carries a failed fleet probe as its own shape, not folded into the array', async () => {
    const failingServer = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')),
      inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'),
      port: 0,
      fleet: () => ({ ok: false, reason: 'powershell timed out' }),
    });
    const failingBase = `http://127.0.0.1:${await failingServer.listen()}`;
    try {
      const state = await (await fetch(`${failingBase}/state`)).json() as Record<string, unknown>;
      const fleetValue = (state['fleet'] as { value: unknown }).value;
      expect(Array.isArray(fleetValue)).toBe(false);
      expect(fleetValue).toEqual({ ok: false, reason: 'powershell timed out' });
    } finally {
      await failingServer.close();
    }
  });

  it('a lane\'s verified_at moves with its file\'s mtime', async () => {
    const first = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const firstAt = ((first['lanes'] as Wrapped<Record<string, unknown>[]>).value[0]?.['verified_at']) as number;

    // Force the file's mtime forward, the way a second passing between two real writes
    // would: writing the same lane again is enough to move it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('alpha', { note: 'touched' });

    const second = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    const secondAt = ((second['lanes'] as Wrapped<Record<string, unknown>[]>).value[0]?.['verified_at']) as number;

    expect(secondAt).toBeGreaterThan(firstAt);
  });

  it('X4: carries router_enabled, off by the real policy\'s own default', async () => {
    const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
    expect(state['router_enabled']).toBe(false);
  });

  // C.3: the desktop status window and the console's top bar both need to say when the
  // queue subsystem is not running at all, distinct from a queue that is running but
  // paused -- read fresh off the environment on every call, the same as router_enabled.
  describe('C.3: carries queue_on, read fresh from FORGE_QUEUE', () => {
    const original = process.env['FORGE_QUEUE'];
    afterEach(() => {
      if (original === undefined) delete process.env['FORGE_QUEUE'];
      else process.env['FORGE_QUEUE'] = original;
    });

    it('reads false when FORGE_QUEUE is unset', async () => {
      delete process.env['FORGE_QUEUE'];
      const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
      expect(state['queue_on']).toBe(false);
    });

    it('reads true only when FORGE_QUEUE is exactly "1"', async () => {
      process.env['FORGE_QUEUE'] = '1';
      const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
      expect(state['queue_on']).toBe(true);
    });

    it('reads false for any other value, never truthy-coerced', async () => {
      process.env['FORGE_QUEUE'] = 'true';
      const state = await (await fetch(`${base}/state`)).json() as Record<string, unknown>;
      expect(state['queue_on']).toBe(false);
    });
  });

  // X1: a lane can carry a stale verdict from an earlier chain (parked, or otherwise
  // finished) while a fresh run for the same slug is genuinely live. A tile driven off
  // the lane record alone would show the dead chain's verdict beside a running tool; the
  // live run has to win.
  it('X1: a live run for a lane overrides that lane\'s stale verdict, class, model and cost', async () => {
    const lanes = new Lanes(join(dir, 'lanes-x1'));
    lanes.put('beta', {
      column: 'blocked', verdict: 'parked', model: 'claude-fable-5', context: 5_000, cost_usd: 0.01,
    });
    const journalPath = join(dir, 'fleet-x1.jsonl');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'beta', actor: 'worker', model: 'claude-sonnet-5', className: 'implement-hard' });
    journal.append({
      event: 'turn.end', run: 'beta', actor: 'worker', context: 91_000, model: 'claude-sonnet-5',
      usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.append({ event: 'tool.start', run: 'beta', actor: 'worker', tool: 'Bash' });
    journal.close();

    const x1Server = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox-x1')), journalPath, port: 0,
    });
    const x1Base = `http://127.0.0.1:${await x1Server.listen()}`;
    try {
      const state = await (await fetch(`${x1Base}/state`)).json() as Record<string, unknown>;
      const lane = (state['lanes'] as Wrapped<Record<string, unknown>[]>).value[0]!;
      expect(lane['run_state']).toBe('started');
      expect(lane['className']).toBe('implement-hard');
      expect(lane['model']).toBe('claude-sonnet-5');
      expect(lane['cost_usd']).toBeGreaterThan(0.01);
      expect(lane['current_tool']).toMatchObject({ name: 'Bash' });
      const runs = state['runs'] as Record<string, { state: string; className?: string }>;
      expect(runs['beta']?.state).toBe('started');
      expect(runs['beta']?.className).toBe('implement-hard');
    } finally {
      await x1Server.close();
    }
  });
});

/**
 * F2: a handed-off chain with no live run left counted as running.
 *
 * `run_state` used to come straight off `fleet.runs[lane.slug]`, which is that key's own
 * last journal line and nothing more. A base run that hands off never gets another event
 * on its own key, so once every successor in the chain finished, crashed or was cleared,
 * the base key's `run.handoff` line was still the last thing on record and `run_state`
 * stayed `'handed-off'` forever -- which `categoryOf` (laneState.ts) counts as running.
 * On 2026-09-05 at 01:05 this showed three fully-dead chains as "3 running" with an
 * empty registry directory.
 */
describe('F2: a handed-off chain counts as running only while the registry backs it', () => {
  const journalPath = () => join(dir, `fleet-f2-${Math.random().toString(36).slice(2)}.jsonl`);

  it('a chain that handed off and finished, with an empty registry, is never running', async () => {
    const lanes = new Lanes(join(dir, 'lanes-f2a'));
    // The three real shapes from 2026-09-05: a handoff chain that ended unverified, a
    // chain that exhausted its sessions, and one still parked on a question. All three
    // read "running" before the fix.
    lanes.put('chain-a', { column: 'forge', model: 'claude-sonnet-5', verdict: 'unverified' });
    lanes.put('chain-b', { column: 'forge', model: 'claude-sonnet-5', verdict: 'exhausted' });
    lanes.put('chain-c', { column: 'forge', model: 'claude-sonnet-5', verdict: 'parked', needs_aaron: 'answer the ask' });

    const jPath = journalPath();
    const journal = new Journal(jPath);
    journal.append({ event: 'run.started', run: 'chain-a', actor: 'runner' });
    journal.append({ event: 'run.handoff', run: 'chain-a', actor: 'worker', successor: 'chain-a-2' });
    journal.append({ event: 'run.started', run: 'chain-a-2', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'chain-a-2', actor: 'worker', verdict: 'unverified' });
    journal.append({ event: 'run.started', run: 'chain-b', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'chain-b', actor: 'worker', verdict: 'exhausted' });
    journal.append({ event: 'run.started', run: 'chain-c', actor: 'runner' });
    journal.append({ event: 'run.parked', run: 'chain-c', actor: 'warden', key: 'ask:1' });
    journal.close();

    const emptyRegistry = new Registry(join(dir, 'registry-f2a-empty'));
    const f2Server = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox-f2a')), journalPath: jPath, registry: emptyRegistry, port: 0,
    });
    const f2Base = `http://127.0.0.1:${await f2Server.listen()}`;
    try {
      const state = await (await fetch(`${f2Base}/state`)).json() as Record<string, unknown>;
      const lanesOut = (state['lanes'] as Wrapped<LaneRecord[]>).value;
      const chainA = lanesOut.find((lane) => lane.slug === 'chain-a')!;
      // The bug: the base key's own last event is `run.handoff`, so a naive read of
      // `fleet.runs['chain-a'].state` is stuck at `'handed-off'` even though the whole
      // chain is over and the registry has nothing for it.
      expect(chainA.run_state).not.toBe('handed-off');
      const counts = { running: 0, blocked: 0, done: 0 };
      for (const lane of lanesOut) counts[categoryOf(lane)] += 1;
      expect(counts.running).toBe(0);
      expect(counts.blocked).toBe(3);
      expect(counts.done).toBe(0);
    } finally {
      await f2Server.close();
    }
  });

  it('the same chain counts as running once the registry backs its successor', async () => {
    const lanes = new Lanes(join(dir, 'lanes-f2b'));
    lanes.put('chain-a', { column: 'forge', model: 'claude-sonnet-5', verdict: 'unverified' });

    const jPath = journalPath();
    const journal = new Journal(jPath);
    journal.append({ event: 'run.started', run: 'chain-a', actor: 'runner' });
    journal.append({ event: 'run.handoff', run: 'chain-a', actor: 'worker', successor: 'chain-a-2' });
    journal.append({ event: 'run.started', run: 'chain-a-2', actor: 'runner' });
    journal.close();

    const liveRegistry = new Registry(join(dir, 'registry-f2b-live'));
    liveRegistry.admit({
      goal: 'chain-a-2', cwd: dir, briefPath: join(dir, 'chain-a.md'), pid: process.pid,
    });
    const f2Server = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox-f2b')), journalPath: jPath, registry: liveRegistry, port: 0,
    });
    const f2Base = `http://127.0.0.1:${await f2Server.listen()}`;
    try {
      const state = await (await fetch(`${f2Base}/state`)).json() as Record<string, unknown>;
      const lanesOut = (state['lanes'] as Wrapped<LaneRecord[]>).value;
      const counts = { running: 0, blocked: 0, done: 0 };
      for (const lane of lanesOut) counts[categoryOf(lane)] += 1;
      expect(counts.running).toBe(1);
    } finally {
      await f2Server.close();
    }
  });
});

describe('GET /inbox', () => {
  it('is empty when nothing is waiting', async () => {
    const body = await (await fetch(`${base}/inbox`)).json() as Record<string, unknown>;
    expect(body['open']).toEqual([]);
  });

  it('lists a question a worker raised', async () => {
    server.inbox.raise({ run: 'alpha', question: 'Which environment?', options: ['dev'] });
    const body = await (await fetch(`${base}/inbox`)).json() as Record<string, unknown>;
    expect((body['open'] as unknown[])).toHaveLength(1);
  });

  // F3: an ask whose every run is dead stays open with no run left to resume. `alpha`
  // has a live registry row (this suite's own beforeEach); `ghost` never gets one.
  it('F3: marks an ask stale once none of its runs has a registry row', async () => {
    server.inbox.raise({ run: 'alpha', question: 'Which environment?', options: ['dev'] });
    server.inbox.raise({ run: 'ghost', question: 'Probe: continue to the end?' });
    const body = await (await fetch(`${base}/inbox`)).json() as Record<string, unknown>;
    const open = body['open'] as Array<Record<string, unknown>>;
    const live = open.find((entry) => entry['runs'] as string[] === undefined
      ? false : (entry['runs'] as string[]).includes('alpha'))!;
    const dead = open.find((entry) => (entry['runs'] as string[]).includes('ghost'))!;
    expect(live['stale']).toBe(false);
    expect(dead['stale']).toBe(true);
    expect(dead['staleReason']).toMatch(/ghost/);
  });
});

describe('POST /clear on a stale inbox ask', () => {
  it('F3: refuses to retire an ask that still has a live run', async () => {
    server.inbox.raise({ run: 'alpha', question: 'Which environment?', options: ['dev'] });
    const [key] = server.inbox.open().map((e) => e.key);
    const response = await fetchConfirmed(`${base}/clear`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ inboxKey: key }),
    });
    expect(response.status).toBe(400);
    expect(server.inbox.open()).toHaveLength(1);
  });

  it('F3: retires a stale ask and journals inbox.retired with the key and runs', async () => {
    server.inbox.raise({ run: 'ghost', question: 'Probe: continue to the end?' });
    const [key] = server.inbox.open().map((e) => e.key);
    const response = await fetchConfirmed(`${base}/clear`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ inboxKey: key }),
    });
    expect(response.status).toBe(200);
    expect(server.inbox.open()).toHaveLength(0);
    const journalText = readFileSync(join(dir, 'fleet.jsonl'), 'utf8');
    const retiredRow = journalText.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row['event'] === 'inbox.retired');
    expect(retiredRow).toMatchObject({ key, runs: ['ghost'] });
  });
});

describe('GET /run/:id', () => {
  // X3: the ticket sheet's own read. Behind the token like every write on this server,
  // since a packet can carry whatever a worker wrote about the goal it was on.
  it('X3: refuses without a token', async () => {
    const response = await fetch(`${base}/run/alpha`);
    expect(response.status).toBe(401);
  });

  it('X3: refuses a different Origin', async () => {
    const response = await fetch(`${base}/run/alpha`, {
      headers: { 'x-forge-token': server.token, origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  it('X3: a run with a packet on disk returns its text and provenance', async () => {
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({
      event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2',
    });
    journal.close();
    mkdirSync(join(dir, 'packets'), { recursive: true });
    writeFileSync(join(dir, 'packets', 'alpha.md'), '# what alpha found\n', 'utf8');
    const withPackets = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0, packetsDir: join(dir, 'packets'),
    });
    const withPacketsBase = `http://127.0.0.1:${await withPackets.listen()}`;
    try {
      const response = await fetch(`${withPacketsBase}/run/alpha`, {
        headers: { 'x-forge-token': withPackets.token },
      });
      const body = await response.json() as Record<string, unknown>;
      expect(body['packet']).toBe('# what alpha found\n');
      expect(body['provenance']).toMatchObject({ successor: 'alpha-2' });
    } finally {
      await withPackets.close();
    }
  });

  it('X3: a run with no packet answers null rather than 404', async () => {
    const response = await fetch(`${base}/run/nothing-ever-ran-here`, {
      headers: { 'x-forge-token': server.token },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body['packet']).toBeNull();
    expect(body['plan']).toBeNull();
    expect(body['prUrl']).toBeNull();
  });
});

describe('POST /router', () => {
  afterEach(() => {
    delete process.env['FORGE_POLICY_PATH'];
  });

  // X4: off by default. This is the real model-policy.json's own default
  // (`router.enabled: false`), not a fixture override -- proving the production
  // default is the safe one, not just that a test can construct a safe one.
  it('X4: routes nothing while the policy has the router off, and never touches a reasoner', async () => {
    let reasonerCalled = false;
    const withReasoner = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'), port: 0,
      reasoner: { provider: 'claude', call: async () => { reasonerCalled = true; return { text: 'x' }; } },
    });
    const withReasonerBase = `http://127.0.0.1:${await withReasoner.listen()}`;
    try {
      const response = await fetch(`${withReasonerBase}/router`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-token': withReasoner.token },
        body: JSON.stringify({ text: 'what is running' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ routed: false, reason: 'router off' });
      expect(reasonerCalled).toBe(false);
    } finally {
      await withReasoner.close();
    }
  });

  it('X4: refuses without a token', async () => {
    const response = await fetch(`${base}/router`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    });
    expect(response.status).toBe(401);
  });

  it('X4: 501s when the router is enabled but no reasoner was wired', async () => {
    const policyPath = join(dir, 'router-on-policy.json');
    writeFileSync(policyPath, JSON.stringify({ router: { enabled: true } }), 'utf8');
    process.env['FORGE_POLICY_PATH'] = policyPath;
    const response = await fetch(`${base}/router`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(response.status).toBe(501);
  });

  it('X4: when enabled and wired, classifies and acts through the fake reasoner only', async () => {
    const policyPath = join(dir, 'router-on-policy-2.json');
    writeFileSync(policyPath, JSON.stringify({ router: { enabled: true } }), 'utf8');
    process.env['FORGE_POLICY_PATH'] = policyPath;

    let calls = 0;
    const reasoner = {
      provider: 'claude' as const,
      call: async () => {
        calls += 1;
        return { text: calls === 1 ? 'intake' : 'unused' };
      },
    };
    const routedLanes = new Lanes(join(dir, 'lanes-routed'));
    const routedServer = new ForgeServer({
      lanes: routedLanes, inbox: new Inbox(join(dir, 'inbox-routed')),
      journalPath: join(dir, 'fleet-routed.jsonl'), port: 0, reasoner,
    });
    const routedBase = `http://127.0.0.1:${await routedServer.listen()}`;
    try {
      const response = await fetch(`${routedBase}/router`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-token': routedServer.token },
        body: JSON.stringify({ text: 'build the new thing' }),
      });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body['routed']).toBe(true);
      expect((body['outcome'] as Record<string, unknown>)['class']).toBe('intake');
      expect(calls).toBe(1);
    } finally {
      await routedServer.close();
    }
  });
});

describe('POST /answer', () => {
  it('answers an open question and closes it', async () => {
    const entry = server.inbox.raise({ run: 'alpha', question: 'Which environment?' });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: entry.key, answer: 'staging' }),
    });

    expect(response.status).toBe(200);
    expect(server.inbox.entry(entry.key)?.answer).toBe('staging');
    expect(server.inbox.open()).toHaveLength(0);
  });

  it('refuses an answer to a key nobody asked', async () => {
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: 'not-a-key', answer: 'yes' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses a body it cannot read rather than guessing', async () => {
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a GET, because answering is not a safe method', async () => {
    expect((await fetch(`${base}/answer`)).status).toBe(405);
  });

  it('B.3.9: refuses a request with no token', async () => {
    const entry = server.inbox.raise({ run: 'alpha', question: 'Which environment?' });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: entry.key, answer: 'staging' }),
    });
    expect(response.status).toBe(401);
    expect(server.inbox.entry(entry.key)?.answer).toBeUndefined();
  });

  it('B.3.9: refuses a request with the wrong token', async () => {
    const entry = server.inbox.raise({ run: 'alpha', question: 'Which environment?' });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': 'not-the-token' },
      body: JSON.stringify({ key: entry.key, answer: 'staging' }),
    });
    expect(response.status).toBe(401);
    expect(server.inbox.entry(entry.key)?.answer).toBeUndefined();
  });

  it('B.3.9: refuses a request from a different Origin', async () => {
    const entry = server.inbox.raise({ run: 'alpha', question: 'Which environment?' });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-forge-token': server.token, origin: 'http://evil.example',
      },
      body: JSON.stringify({ key: entry.key, answer: 'staging' }),
    });
    expect(response.status).toBe(403);
    expect(server.inbox.entry(entry.key)?.answer).toBeUndefined();
  });

  it('B.3.9: refuses a null body', async () => {
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
    });
    expect(response.status).toBe(400);
  });

  it('B.3.9: refuses an oversized body', async () => {
    const entry = server.inbox.raise({ run: 'alpha', question: 'Which environment?' });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: entry.key, answer: 'x'.repeat(100_000) }),
    });
    expect(response.status).toBe(413);
    expect(server.inbox.entry(entry.key)?.answer).toBeUndefined();
  });

  function journalRows(): Record<string, unknown>[] {
    return readFileSync(join(dir, 'fleet.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('writes an interview.answered row when the run answered is an item: run', async () => {
    const entry = server.inbox.raise({
      run: 'item:Q-abc123', question: 'hide the row or show a zero?', ticket: 'BBZ-277',
    });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: entry.key, answer: 'hide' }),
    });
    expect(response.status).toBe(200);

    const rows = journalRows().filter((row) => row['event'] === 'interview.answered');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['itemId']).toBe('Q-abc123');
    expect(rows[0]!['ticket']).toBe('BBZ-277');
    expect(rows[0]!['askKey']).toBe(entry.key);
    expect(rows[0]!['answeredBy']).toBe('the operator');
  });

  // Edge case: an answer for a run that is NOT an item: run (an ordinary worker ask) must
  // never get an interview.answered row -- that name is reserved for the planning-hop
  // interview, and a plain worker ask is a different thing entirely.
  it('writes no interview.answered row when the run answered is not an item: run', async () => {
    const entry = server.inbox.raise({ run: 'alpha', question: 'Which environment?' });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: entry.key, answer: 'staging' }),
    });
    expect(response.status).toBe(200);
    expect(journalRows().some((row) => row['event'] === 'interview.answered')).toBe(false);
  });

  // Edge case: an answer arriving for an ask that is already answered (a stale retry, or
  // a person clicking twice) is rejected by `Inbox.answer`... except `Inbox.answer` does
  // not itself refuse a re-answer -- it just overwrites. So a second POST still succeeds
  // and still journals a second interview.answered row: each POST that lands is one
  // answer event, whether or not it is the first for that key. Documented here rather
  // than treated as a bug -- fixing double-answer semantics is a separate concern from
  // journaling that an answer arrived.
  it('a second answer to the same item: ask still writes its own interview.answered row', async () => {
    const entry = server.inbox.raise({ run: 'item:Q-xyz', question: 'hide or zero?', ticket: 'BBZ-1' });
    await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: entry.key, answer: 'hide' }),
    });
    await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: entry.key, answer: 'zero' }),
    });
    expect(journalRows().filter((row) => row['event'] === 'interview.answered')).toHaveLength(2);
  });

  // Edge case: an empty answer string is still a real answer (the operator explicitly
  // chose "nothing"), not a no-op -- it must still be journaled.
  it('an empty-string answer to an item: ask still writes an interview.answered row', async () => {
    const entry = server.inbox.raise({ run: 'item:Q-empty', question: 'anything to add?', ticket: 'BBZ-2' });
    const response = await fetch(`${base}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ key: entry.key, answer: '' }),
    });
    expect(response.status).toBe(200);
    expect(journalRows().filter((row) => row['event'] === 'interview.answered')).toHaveLength(1);
  });
});

describe('POST /stop', () => {
  it('W6: parks every running lane and engages the kill switch', async () => {
    const response = await fetchConfirmed(`${base}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ reason: 'test stop' }),
    });
    const body = await response.json() as { stopped: string[] };

    expect(response.status).toBe(200);
    expect(body.stopped).toContain('alpha');
    expect(readKillSwitch(join(dir, 'kill-switch.json')).engaged).toBe(true);
  });

  it('W6: refuses without a token', async () => {
    const response = await fetch(`${base}/stop`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  it('W6: refuses a different Origin', async () => {
    const response = await fetch(`${base}/stop`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, origin: 'http://evil.example' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('W6: refuses a body it cannot parse', async () => {
    const response = await fetch(`${base}/stop`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a GET, because stopping is not a safe method', async () => {
    expect((await fetch(`${base}/stop`)).status).toBe(405);
  });
});

describe('POST /send', () => {
  it('W6: queues a message into the run\'s own inbox', async () => {
    const response = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ run: 'alpha', text: 'rebase first' }),
    });
    expect(response.status).toBe(200);
    expect(new RunInbox('alpha').all().map((message) => message.text)).toContain('rebase first');
  });

  it('W6: refuses without a token', async () => {
    const response = await fetch(`${base}/send`, {
      method: 'POST',
      body: JSON.stringify({ run: 'alpha', text: 'hi' }),
    });
    expect(response.status).toBe(401);
  });

  it('W6: refuses a different Origin', async () => {
    const response = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, origin: 'http://evil.example' },
      body: JSON.stringify({ run: 'alpha', text: 'hi' }),
    });
    expect(response.status).toBe(403);
  });

  it('W6: refuses a body missing run or text', async () => {
    const response = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ run: 'alpha' }),
    });
    expect(response.status).toBe(400);
  });

  it('W6: refuses a body it cannot parse', async () => {
    const response = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /amend', () => {
  it('C.1: appends an Amendment section, folds the text into Definition of Done, '
    + 'delivers it through the run inbox, and journals brief.amended', async () => {
    const briefPath = join(dir, 'alpha.md');
    writeFileSync(briefPath, [
      '# alpha',
      '',
      '## Definition of Done',
      '- ship it',
      '',
      '## Notes',
      'stuff',
      '',
    ].join('\n'), 'utf8');

    const response = await fetch(`${base}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ run: 'alpha', text: 'also handle the null case' }),
    });
    expect(response.status).toBe(200);

    const updated = readFileSync(briefPath, 'utf8');
    expect(updated).toMatch(/## Amendment \(/);
    const dodSection = updated.slice(
      updated.indexOf('## Definition of Done'), updated.indexOf('## Notes'),
    );
    expect(dodSection).toContain('also handle the null case');

    expect(
      new RunInbox('alpha').all().map((message) => message.text)
        .some((text) => text.includes('also handle the null case')),
    ).toBe(true);

    const journalText = readFileSync(join(dir, 'fleet.jsonl'), 'utf8');
    const rows = journalText.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.some((row) => row['event'] === 'brief.amended' && row['run'] === 'alpha')).toBe(true);
  });

  it('refuses without a token', async () => {
    const response = await fetch(`${base}/amend`, {
      method: 'POST',
      body: JSON.stringify({ run: 'alpha', text: 'hi' }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a different Origin', async () => {
    const response = await fetch(`${base}/amend`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, origin: 'http://evil.example' },
      body: JSON.stringify({ run: 'alpha', text: 'hi' }),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a body missing run or text', async () => {
    const response = await fetch(`${base}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ run: 'alpha' }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a body it cannot parse', async () => {
    const response = await fetch(`${base}/amend`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('404s a run with no registry row rather than guessing a brief path', async () => {
    const response = await fetch(`${base}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ run: 'nobody', text: 'hi' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses a GET, because amending is not a safe method', async () => {
    const response = await fetch(`${base}/amend`, { method: 'GET' });
    expect(response.status).toBe(405);
  });
});

describe('POST /clear', () => {
  it('W6: clears a breaker-blocked lane', async () => {
    const lanes = new Lanes(join(dir, 'lanes'));
    new Breaker(lanes).noteZeroTurnStart('alpha');
    new Breaker(lanes).noteZeroTurnStart('alpha');
    new Breaker(lanes).noteZeroTurnStart('alpha');
    expect(new Breaker(lanes).blocked('alpha')).toBe(true);

    const response = await fetch(`${base}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ lane: 'alpha' }),
    });
    expect(response.status).toBe(200);
    expect(new Breaker(lanes).blocked('alpha')).toBe(false);
  });

  it('W6: clears the kill switch with { all: true }', async () => {
    writeFileSync(join(dir, 'kill-switch.json'), JSON.stringify({ reason: 'x', at: Date.now() }), 'utf8');
    const response = await fetch(`${base}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({ all: true }),
    });
    expect(response.status).toBe(200);
    expect(readKillSwitch(join(dir, 'kill-switch.json')).engaged).toBe(false);
  });

  it('W6: refuses without a token', async () => {
    const response = await fetch(`${base}/clear`, { method: 'POST', body: JSON.stringify({ lane: 'alpha' }) });
    expect(response.status).toBe(401);
  });

  it('W6: refuses a different Origin', async () => {
    const response = await fetch(`${base}/clear`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token, origin: 'http://evil.example' },
      body: JSON.stringify({ lane: 'alpha' }),
    });
    expect(response.status).toBe(403);
  });

  it('W6: refuses a body naming neither a lane nor { all: true }', async () => {
    const response = await fetch(`${base}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': server.token },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('W6: refuses a body it cannot parse', async () => {
    const response = await fetch(`${base}/clear`, {
      method: 'POST',
      headers: { 'x-forge-token': server.token },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('GET / (the built console)', () => {
  it('W6: serves index.html with the real token injected into the meta tag', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'forge-console-dist-'));
    writeFileSync(
      join(distDir, 'index.html'),
      '<html><head><meta name="forge-token" content="" /></head><body></body></html>',
      'utf8',
    );
    const withStatic = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')),
      inbox: new Inbox(join(dir, 'inbox')),
      journalPath: join(dir, 'fleet.jsonl'),
      port: 0,
      token: 'the-real-token',
      consoleDistDir: distDir,
    });
    const staticBase = `http://127.0.0.1:${await withStatic.listen()}`;
    try {
      const html = await (await fetch(`${staticBase}/`)).text();
      expect(html).toContain('content="the-real-token"');
      expect(html).not.toContain('content="" />');
    } finally {
      await withStatic.close();
    }
  });

  it('W6: a missing built asset is a 404 naming the build command, not a stack trace', async () => {
    const response = await fetch(`${base}/does-not-exist.js`);
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('console:build');
  });
});

describe('POST /run/:id/retire and /run/:id/unretire (H1.7)', () => {
  it('refuses to retire a lane that is still running', async () => {
    const response = await fetchConfirmed(`${base}/run/alpha/retire`, {
      method: 'POST', headers: { 'x-forge-token': server.token },
    });
    expect(response.status).toBe(409);
  });

  it('retires a finished lane, drops it from /lanes, and unretire brings it back', async () => {
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'beta', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'beta', actor: 'runner', verdict: 'done' });
    journal.close();
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('beta', { column: 'c2' });

    const retire = await fetchConfirmed(`${base}/run/beta/retire`, {
      method: 'POST', headers: { 'x-forge-token': server.token },
    });
    expect(retire.status).toBe(200);

    const afterRetire = await (await fetch(`${base}/lanes`, { headers: { 'x-forge-token': server.token } })).json() as { lanes: Array<{ id: string }> };
    expect(afterRetire.lanes.map((lane) => lane.id)).not.toContain('beta');

    const archived = await (await fetch(`${base}/lanes?archived=1`, { headers: { 'x-forge-token': server.token } })).json() as { lanes: Array<{ id: string; retiredAt: number | null }> };
    const betaArchived = archived.lanes.find((lane) => lane.id === 'beta');
    expect(betaArchived?.retiredAt).not.toBeNull();

    const unretire = await fetch(`${base}/run/beta/unretire`, {
      method: 'POST', headers: { 'x-forge-token': server.token },
    });
    expect(unretire.status).toBe(200);

    const afterUnretire = await (await fetch(`${base}/lanes`, { headers: { 'x-forge-token': server.token } })).json() as { lanes: Array<{ id: string }> };
    expect(afterUnretire.lanes.map((lane) => lane.id)).toContain('beta');
  });
});

describe('POST /retire-finished (H1.7)', () => {
  it('retires every finished lane and leaves the running one alone', async () => {
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'beta', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'beta', actor: 'runner', verdict: 'done' });
    journal.close();
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('beta', { column: 'c2' });

    const response = await fetchConfirmed(`${base}/retire-finished`, {
      method: 'POST', headers: { 'x-forge-token': server.token },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { retired: string[] };
    expect(body.retired).toContain('beta');
    expect(body.retired).not.toContain('alpha');
  });
});

describe('GET /retire-finished (H1.7 preview)', () => {
  it('previews what a bulk retire would touch, retiring nothing', async () => {
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'beta', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'beta', actor: 'runner', verdict: 'done' });
    journal.close();
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('beta', { column: 'c2' });

    const preview = await fetch(`${base}/retire-finished`, {
      headers: { 'x-forge-token': server.token },
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { items: Array<{ id: string }> };
    expect(previewBody.items.map((i) => i.id)).toContain('beta');
    expect(previewBody.items.map((i) => i.id)).not.toContain('alpha');

    const after = await (await fetch(`${base}/lanes`, { headers: { 'x-forge-token': server.token } })).json() as { lanes: Array<{ id: string }> };
    expect(after.lanes.map((lane) => lane.id)).toContain('beta');
  });
});

describe('GET /merge-ready and POST /merge-ready (H1.8)', () => {
  it('GET reports a queue lane with a bare, unread PR as not-ready ("checks pending")', async () => {
    const { QueueStore } = await import('../../src/forge/intake/queueStore.js');
    const queueStore = new QueueStore(join(dir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n', briefPath: 'b.md',
      branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop', state: 'review', reason: null,
      runKey: 'queue-BBZ-96', pr: { no: 5, url: 'https://github.com/o/n/pull/5', files: 1, add: 1, del: 0, draft: true },
      journalIds: [], createdAt: 1, updatedAt: 1,
    });
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'queue-BBZ-96', actor: 'runner', verdict: 'done' });
    journal.close();
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'c3' });

    process.env['FORGE_QUEUE_MERGE_REPOS'] = 'o/n';
    const withQueue = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
      registry: new Registry(join(dir, 'registry')), port: 0, queueStore,
    });
    const queueBase = `http://127.0.0.1:${await withQueue.listen()}`;
    try {
      const report = await (await fetch(`${queueBase}/merge-ready`, {
        headers: { 'x-forge-token': withQueue.token },
      })).json() as { ready: unknown[]; notReady: Array<{ id: string; why: string }> };
      expect(report.ready).toEqual([]);
      expect(report.notReady).toEqual([{ id: 'queue-BBZ-96', why: 'checks pending' }].map((r) => expect.objectContaining(r)));
    } finally {
      delete process.env['FORGE_QUEUE_MERGE_REPOS'];
      await withQueue.close();
    }
  });

  it('POST merges every ready lane through the queue\'s own mergeItem path', async () => {
    process.env['FORGE_QUEUE_MERGE_REPOS'] = 'o/n';
    const { QueueStore } = await import('../../src/forge/intake/queueStore.js');
    const queueStore = new QueueStore(join(dir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n', briefPath: 'b.md',
      branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop', state: 'review', reason: null,
      runKey: 'queue-BBZ-96',
      pr: {
        no: 5, url: 'https://github.com/o/n/pull/5', files: 1, add: 1, del: 0, draft: true,
        checks: 'success', verdict: 'PASS', merged: false,
      },
      journalIds: [], createdAt: 1, updatedAt: 1,
    });
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'queue-BBZ-96', actor: 'runner', verdict: 'done' });
    journal.close();
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'c3' });

    let gateCalled = false;
    const withQueue = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
      registry: new Registry(join(dir, 'registry')), port: 0, queueStore,
      queueMergeDeps: {
        mergeAllowed: () => true,
        gate: async () => { gateCalled = true; return { merged: true }; },
        clock: () => 9_000,
        store: queueStore,
      },
    });
    const queueBase = `http://127.0.0.1:${await withQueue.listen()}`;
    try {
      const before = await (await fetch(`${queueBase}/merge-ready`, {
        headers: { 'x-forge-token': withQueue.token },
      })).json() as { ready: Array<{ id: string }> };
      expect(before.ready.map((r) => r.id)).toEqual(['queue-BBZ-96']);

      const result = await fetchConfirmed(`${queueBase}/merge-ready`, {
        method: 'POST', headers: { 'x-forge-token': withQueue.token },
      });
      expect(result.status).toBe(200);
      const body = await result.json() as { ok: boolean; outcomes: Array<{ id: string; ok: boolean }> };
      expect(gateCalled).toBe(true);
      expect(body.outcomes).toEqual([{ id: 'queue-BBZ-96', ok: true }].map((r) => expect.objectContaining(r)));
      expect(queueStore.get('Q-1')?.state).toBe('done');
    } finally {
      delete process.env['FORGE_QUEUE_MERGE_REPOS'];
      await withQueue.close();
    }
  });
});

describe('GET /run/:id/summary, POST /run/:id/recheck, POST /run/:id/reaudit (2026-09-07)', () => {
  it('GET /run/:id/summary folds a fresh PR read, the attestation and drift into one summary', async () => {
    const { QueueStore } = await import('../../src/forge/intake/queueStore.js');
    const queueStore = new QueueStore(join(dir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n', briefPath: null,
      branch: 'feature/bbz-96', worktreePath: dir, base: 'develop', state: 'review', reason: null,
      runKey: 'queue-BBZ-96', pr: { no: 5, url: 'https://github.com/o/n/pull/5', draft: true },
      journalIds: [], createdAt: 1, updatedAt: 1,
    });
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.close();
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'c4' });

    const consoleReads = new ConsoleReads({
      forgeHomeDir: dir, journalPath: join(dir, 'fleet.jsonl'), lanes,
      registry: new Registry(join(dir, 'registry')), inbox: new Inbox(join(dir, 'inbox')),
      queueStore, jiraSite: null, mergeAllowed: () => true,
      ghDetailLookup: async () => ({
        headSha: 'sha1', isDraft: true, merged: false, title: 'wire the merge chip',
        checks: 'success', body: null,
      }),
      driftFn: async () => ({ behindBase: 0, headMoved: false }),
      gitLog: async () => [],
    });
    const withSummary = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
      registry: new Registry(join(dir, 'registry')), port: 0, queueStore, consoleReads,
    });
    const summaryBase = `http://127.0.0.1:${await withSummary.listen()}`;
    try {
      const response = await fetch(`${summaryBase}/run/queue-BBZ-96/summary`, {
        headers: { 'x-forge-token': withSummary.token },
      });
      expect(response.status).toBe(200);
      const summary = await response.json() as { what: string[]; readiness: { checks: string } | null };
      expect(summary.what).toContain('wire the merge chip.');
      expect(summary.readiness?.checks).toBe('success');
    } finally {
      await withSummary.close();
    }
  });

  it('POST /run/:id/recheck answers the same shape as the GET, freshly computed', async () => {
    const { QueueStore } = await import('../../src/forge/intake/queueStore.js');
    const queueStore = new QueueStore(join(dir, 'console', 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n', briefPath: null,
      branch: 'feature/bbz-96', worktreePath: dir, base: 'develop', state: 'review', reason: null,
      runKey: 'queue-BBZ-96', pr: { no: 5, url: 'https://github.com/o/n/pull/5', draft: true },
      journalIds: [], createdAt: 1, updatedAt: 1,
    });
    const journal = new Journal(join(dir, 'fleet.jsonl'));
    journal.append({ event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    journal.close();
    const lanes = new Lanes(join(dir, 'lanes'));
    lanes.put('queue-BBZ-96', { column: 'c4' });

    const consoleReads = new ConsoleReads({
      forgeHomeDir: dir, journalPath: join(dir, 'fleet.jsonl'), lanes,
      registry: new Registry(join(dir, 'registry')), inbox: new Inbox(join(dir, 'inbox')),
      queueStore, jiraSite: null, mergeAllowed: () => true,
      ghDetailLookup: async () => ({
        headSha: 'sha2', isDraft: true, merged: false, title: 'wire the merge chip',
        checks: 'pending', body: null,
      }),
      driftFn: async () => ({ behindBase: 2, headMoved: false }),
      gitLog: async () => [],
    });
    const withRecheck = new ForgeServer({
      lanes, inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
      registry: new Registry(join(dir, 'registry')), port: 0, queueStore, consoleReads,
    });
    const recheckBase = `http://127.0.0.1:${await withRecheck.listen()}`;
    try {
      const response = await fetch(`${recheckBase}/run/queue-BBZ-96/recheck`, {
        method: 'POST', headers: { 'x-forge-token': withRecheck.token },
      });
      expect(response.status).toBe(200);
      const summary = await response.json() as { readiness: { checks: string; behindBase: number } | null };
      expect(summary.readiness?.checks).toBe('pending');
      expect(summary.readiness?.behindBase).toBe(2);
    } finally {
      await withRecheck.close();
    }
  });

  it('POST /run/:id/reaudit refuses with no repo/PR on record', async () => {
    const response = await fetch(`${base}/run/alpha/reaudit`, {
      method: 'POST', headers: { 'x-forge-token': server.token },
    });
    expect(response.status).toBe(501);
  });

  // The "fires the council CLI and answers started:true" behavior is proven at the
  // `reauditRun` unit level (tests/forge/console/run-actions.test.ts), which injects a
  // fake `spawnFn` directly -- `ForgeServer` has no HTTP-reachable seam to fake the CLI
  // spawn, and this suite never lets a real `forge council` subprocess start (order 9).
});

describe('anything else', () => {
  it('is a 404 rather than a stack trace', async () => {
    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
  });
});

describe('the events websocket', () => {
  it('completes the handshake and pushes an event as a text frame', async () => {
    const frames = await collectFrames(`ws://127.0.0.1:${server.port}/events`, () => {
      server.publish({ event: 'turn.end', run: 'alpha', context: 51_000 });
    });
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)['run']).toBe('alpha');
  });

  it('pushes to every listener, not just the first', async () => {
    // Both sockets have to be listening before the publish, or the row passes on
    // whichever one happened to connect first and proves nothing about the second.
    let open = 0;
    const ready = () => { open += 1; };
    const url = `ws://127.0.0.1:${server.port}/events`;
    const first = collectFrames(url, () => {}, 1, 3000, ready);
    const second = collectFrames(url, () => {}, 1, 3000, ready);

    while (open < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.listeners).toBe(2);
    server.publish({ event: 'turn.end', run: 'alpha' });

    const [a, b] = await Promise.all([first, second]);
    expect(JSON.parse(a[0]!)['run']).toBe('alpha');
    expect(JSON.parse(b[0]!)['run']).toBe('alpha');
  });

  it('drops a listener that goes away without taking the server with it', async () => {
    await collectFrames(`ws://127.0.0.1:${server.port}/events`, () => {
      server.publish({ event: 'turn.end', run: 'alpha' });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => server.publish({ event: 'turn.end', run: 'alpha' })).not.toThrow();
  });
});

/**
 * Speak just enough of RFC 6455 to prove the server does.
 *
 * A client here rather than a library, because the point of the specimen is that the
 * handshake and the framing are right; asserting them through a library that would also
 * have to be right proves less.
 */
async function collectFrames(
  url: string, trigger: () => void, want = 1, timeoutMs = 2000, onReady: () => void = () => {},
): Promise<string[]> {
  const { createHash, randomBytes } = await import('node:crypto');
  const { connect } = await import('node:net');
  const parsed = new URL(url);

  return new Promise<string[]>((resolve, reject) => {
    const socket = connect(Number(parsed.port), parsed.hostname, () => {
      const key = randomBytes(16).toString('base64');
      socket.write(
        `GET ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\n`
        + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      socket.once('data', (head) => {
        const text = head.toString('latin1');
        const accept = createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!text.includes('101') || !text.includes(accept)) {
          reject(new Error(`handshake failed: ${text.split('\r\n')[0]}`));
          return;
        }
        const frames: string[] = [];
        socket.on('data', (chunk) => {
          frames.push(...readTextFrames(chunk));
          if (frames.length >= want) {
            socket.destroy();
            resolve(frames);
          }
        });
        onReady();
        trigger();
      });
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('no frame arrived')); }, timeoutMs);
  });
}

/** Unmask-free reader for server frames, which are never masked. */
function readTextFrames(buffer: Buffer): string[] {
  const frames: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const length = buffer[offset + 1]! & 0x7f;
    let start = offset + 2;
    let size = length;
    if (length === 126) {
      size = buffer.readUInt16BE(offset + 2);
      start = offset + 4;
    } else if (length === 127) {
      size = Number(buffer.readBigUInt64BE(offset + 2));
      start = offset + 10;
    }
    if (start + size > buffer.length) break;
    frames.push(buffer.subarray(start, start + size).toString('utf8'));
    offset = start + size;
  }
  return frames;
}

// These two stand up a second real ForgeServer, bind a port and close it again. They
// run in about 90ms on a developer machine and timed out at the 5s default twice on the
// windows-latest runner on 2026-09-08 (run 34289785916), in a suite of 196 files sharing
// one box. What stalls there is not diagnosed: `close()` already destroys its accepted
// sockets, so it is not the usual keep-alive hang. The budget is generous rather than
// tight so ordinary contention cannot fail them, and a real deadlock still will.
const REAL_SERVER_TIMEOUT_MS = 20_000;

describe('GET /blockers (iteration 6: mounted on the real server)', () => {
  it('answers 200 with {blockers, chains} on a fleet with one open ask', async () => {
    const { Inbox: InboxCtor } = await import('../../src/forge/inbox.js');
    const inbox = new InboxCtor(join(dir, 'inbox'));
    inbox.raise({ run: 'alpha', question: 'which environment?' });

    const withInbox = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox, journalPath: join(dir, 'fleet.jsonl'),
      registry: new Registry(join(dir, 'registry')), port: 0,
    });
    const blockersBase = `http://127.0.0.1:${await withInbox.listen()}`;
    try {
      const response = await fetch(`${blockersBase}/blockers`, {
        headers: { 'x-forge-token': withInbox.token },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { blockers: Array<{ id: string; kind: string }>; chains: string[][] };
      expect(body.blockers.some((b) => b.kind === 'question')).toBe(true);
      expect(body.chains.length).toBeGreaterThan(0);
    } finally {
      await withInbox.close();
    }
  }, REAL_SERVER_TIMEOUT_MS);

  it('POST /blockers/:id/check answers 200 with an honest not-yet when nothing confirms the kind', async () => {
    const { Inbox: InboxCtor } = await import('../../src/forge/inbox.js');
    const inbox = new InboxCtor(join(dir, 'inbox'));
    const entry = inbox.raise({ run: 'alpha', question: 'which environment?' });

    const withInbox = new ForgeServer({
      lanes: new Lanes(join(dir, 'lanes')), inbox, journalPath: join(dir, 'fleet.jsonl'),
      registry: new Registry(join(dir, 'registry')), port: 0,
      blockersConfirmers: {},
    });
    const blockersBase = `http://127.0.0.1:${await withInbox.listen()}`;
    try {
      const result = await fetch(`${blockersBase}/blockers/${encodeURIComponent(`question:${entry.key}`)}/check`, {
        method: 'POST', headers: { 'x-forge-token': withInbox.token },
      });
      expect(result.status).toBe(200);
      const body = await result.json() as { ok: boolean; lastCheck: string | null };
      expect(body.ok).toBe(false);
      expect(body.lastCheck).toBe('no confirmation is wired for question yet');
    } finally {
      await withInbox.close();
    }
  }, REAL_SERVER_TIMEOUT_MS);
});

describe('listen: a port already held', () => {
  it('rejects with the bind error instead of resolving', async () => {
    const { createServer } = await import('node:net');
    const { ForgeServer } = await import('../../src/forge/server.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const address = holder.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const home = mkdtempSync(join(tmpdir(), 'forge-listen-'));
    const server = new ForgeServer({
      port, host: '127.0.0.1',
      lanes: { list: () => [] } as never, inbox: {} as never, journalPath: join(home, 'fleet.jsonl'),
      registry: {} as never, stuck: () => [], reasoner: undefined as never, fleet: () => [],
      tokenPath: join(home, 'token'),
    } as never);
    await expect(server.listen()).rejects.toMatchObject({ code: expect.stringMatching(/EADDRINUSE|EACCES/) });
    holder.close();
  });
});
