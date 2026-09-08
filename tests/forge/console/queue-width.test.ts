/**
 * `POST /queue/width` (queue-throughput W2): the env sets the initial width, a POST
 * changes it live, and the change is on disk at `join(forgeHome(), 'console',
 * 'queue.json')` -- a fresh reader constructed after the POST sees it too, and a
 * subscribed listener hears about the change over the same `/events` channel every
 * other console write already uses.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { QueueTicketSearch } from '../../../src/forge/intake/queue.js';
import { readQueueWidth } from '../../../src/forge/console/queue-width.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import type { ActionResult, QueueResponse } from '../../../src/shared/console-model.js';

let dir: string;
let server: ForgeServer;
let base: string;
let queueStore: QueueStore;
let search: QueueTicketSearch;
const token = 'the-token';

async function buildServer(queueMaxInFlight?: number): Promise<void> {
  const modelPolicyPath = join(dir, 'model-policy.json');
  writeFileSync(modelPolicyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')),
    journalPath: join(dir, 'fleet.jsonl'), port: 0, token, modelPolicyPath,
    queueStore, queueSearch: search, ...(queueMaxInFlight !== undefined ? { queueMaxInFlight } : {}),
  });
  base = `http://127.0.0.1:${await server.listen()}`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'console-queue-width-'));
  mkdirSync(join(dir, 'lanes'), { recursive: true });
  process.env['FORGE_HOME'] = dir;
  new Journal(join(dir, 'fleet.jsonl')).close();
  queueStore = new QueueStore(join(dir, 'queue.jsonl'));
  search = { searchKeys: async () => ['ABC-1'] };
});

afterEach(async () => {
  await server.close();
  delete process.env['FORGE_HOME'];
});

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, 'x-forge-token': token } };
}

describe('the env seeds the width at startup', () => {
  it('an explicit queueMaxInFlight lands in GET /queue before any POST', async () => {
    await buildServer(7);
    const body = await (await fetch(`${base}/queue`, authed())).json() as QueueResponse;
    expect(body.maxInFlight).toBe(7);
  });

  it('with no queueMaxInFlight, the default is 4', async () => {
    await buildServer();
    const body = await (await fetch(`${base}/queue`, authed())).json() as QueueResponse;
    expect(body.maxInFlight).toBe(4);
  });
});

describe('POST /queue/width', () => {
  beforeEach(async () => {
    await buildServer(2);
  });

  it('changes the width, reflected on the next GET /queue', async () => {
    const response = await fetch(`${base}/queue/width`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxInFlight: 9 }),
    }));
    expect(response.status).toBe(200);
    const result = await response.json() as ActionResult;
    expect(result.ok).toBe(true);

    const listed = await (await fetch(`${base}/queue`, authed())).json() as QueueResponse;
    expect(listed.maxInFlight).toBe(9);
  });

  it('lands on disk at console/queue.json -- a fresh reader off the same FORGE_HOME sees it', async () => {
    await fetch(`${base}/queue/width`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxInFlight: 6 }),
    }));

    const widthPath = join(dir, 'console', 'queue.json');
    expect(existsSync(widthPath)).toBe(true);
    expect(JSON.parse(readFileSync(widthPath, 'utf8'))).toEqual({ maxInFlight: 6 });

    // A fresh reader, called with no server involved at all, still sees the change --
    // proving the value lives on disk, not only in this process's memory.
    expect(readQueueWidth(widthPath)).toBe(6);
  });

  it('refuses a non-integer with the exact 400 message', async () => {
    const response = await fetch(`${base}/queue/width`, authed({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxInFlight: 3.5 }),
    }));
    expect(response.status).toBe(400);
    const result = await response.json() as ActionResult;
    expect(result.message).toBe('maxInFlight must be an integer between 1 and 12');

    const listed = await (await fetch(`${base}/queue`, authed())).json() as QueueResponse;
    expect(listed.maxInFlight).toBe(2);
  });

  it('refuses 0 and 13, the two edges just outside 1..12', async () => {
    for (const value of [0, 13]) {
      const response = await fetch(`${base}/queue/width`, authed({
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxInFlight: value }),
      }));
      expect(response.status).toBe(400);
      const result = await response.json() as ActionResult;
      expect(result.message).toBe('maxInFlight must be an integer between 1 and 12');
    }
  });

  it('accepts the two edges of the range, 1 and 12', async () => {
    for (const value of [1, 12]) {
      const response = await fetch(`${base}/queue/width`, authed({
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxInFlight: value }),
      }));
      expect(response.status).toBe(200);
    }
  });

  it('publishes exactly one event over /events on a successful change', async () => {
    const frames = await collectFrames(`ws://127.0.0.1:${server.port}/events`, () => {
      void fetch(`${base}/queue/width`, authed({
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxInFlight: 5 }),
      }));
    });
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0]!) as Record<string, unknown>;
    expect(parsed['kind']).toBe('queue');
    expect(parsed['maxInFlight']).toBe(5);
  });

  it('publishes nothing on a rejected out-of-range change', async () => {
    await expect(collectFrames(`ws://127.0.0.1:${server.port}/events`, () => {
      void fetch(`${base}/queue/width`, authed({
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxInFlight: 99 }),
      }));
    }, 1, 300)).rejects.toThrow('no frame arrived');
  });
});

// The same handshake helper `tests/forge/server.test.ts` uses to prove `/events` --
// duplicated rather than imported, since that file exports nothing for another
// suite to reuse.
async function collectFrames(
  url: string, trigger: () => void, want = 1, timeoutMs = 2000,
): Promise<string[]> {
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
