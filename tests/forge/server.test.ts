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
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { Lanes } from '../../src/forge/supervisor.js';
import { ForgeServer, FORGE_PORT } from '../../src/forge/server.js';

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

  server = new ForgeServer({
    lanes,
    inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'),
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
