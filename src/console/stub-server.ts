/**
 * The fixture server cut 1 tests and screenshots against, standing in for
 * the real forge server on 4120 until PR #3 (B.3.9) merges and W6 wires the
 * console's routes into `src/forge/server.ts` for real.
 *
 * Serves the built `dist/console/` tree at `/`, injecting a token into the
 * `forge-token` meta tag the same way the real server will, plus the six
 * routes the console calls: `/state`, `/inbox`, `/answer`, `/stop`, `/send`,
 * `/clear`, and a minimal `/events` WebSocket. This file is never imported
 * by `src/forge/**` and never edits it; it is cut 1's own scaffolding, port
 * and all read from the environment so nothing machine-specific is baked in.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { InboxEntry, InboxState } from './types.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = join(HERE, '..', '..', 'dist', 'console');
const PORT = Number(process.env['FORGE_STUB_PORT'] ?? 4130);
const TOKEN = process.env['FORGE_STUB_TOKEN'] ?? 'stub-token';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let inbox: InboxState = {
  open: [
    {
      key: 'a1b2c3d4e5f60718',
      question: 'dev tenant or the production Auth0 tenant for this run?',
      options: ['dev', 'production'],
      kind: 'question',
      runs: ['withdrawal-fee'],
      asked: 1,
      at: Date.now() - 8 * 60_000,
      disposition: 'park',
      ticket: 'BBZ-412',
    },
  ],
  all: [],
};
inbox.all = [...inbox.open];

function stateNow(): Record<string, unknown> {
  const now = Date.now();
  return {
    at: now,
    lanes: {
      value: [
        {
          slug: 'card-network-glow',
          column: 'in-progress',
          owner: 'forge',
          session_id: 'sess-9f21',
          claude_pid: 44821,
          started: now - 42 * 60_000,
          ended: null,
          verdict: null,
          position: 1,
          note: null,
          woken: 0,
          model: 'claude-sonnet-5',
          context: 86_000,
          cost_usd: 4.32,
          handoff: null,
          usd_per_hour: 6.17,
          verified_at: now - 4_000,
          last_event_age_s: 12,
          current_tool: { name: 'Bash', startedAt: now - 12_000 },
          goal: 'card-network-glow-launch',
          className: 'implement',
          provider: 'anthropic',
        },
        {
          slug: 'withdrawal-fee',
          column: 'blocked',
          owner: 'forge',
          session_id: 'sess-7a03',
          claude_pid: 44902,
          started: now - 3 * 3_600_000,
          ended: null,
          verdict: null,
          position: 2,
          note: 'parked on a question',
          woken: 1,
          model: 'claude-sonnet-5',
          context: 141_000,
          cost_usd: 11.06,
          handoff: null,
          usd_per_hour: 3.69,
          verified_at: now - 8 * 60_000,
          last_event_age_s: 480,
          current_tool: null,
          goal: 'withdrawal-fee',
          className: 'implement-hard',
          provider: 'anthropic',
        },
      ],
      verified_at: now,
    },
    burn: { value: { sonnet: 24.29, haiku: 1.04 }, observed_at: now - 30_000 },
    handoffs: { value: 2, verified_at: now },
    torn: { value: 0, verified_at: now },
    inbox_open: { value: inbox.open.length, verified_at: now },
    stuck: { value: [], verified_at: now },
    fleet: { value: [{ name: 'warden', pid: 4021, alive: true }], verified_at: now },
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

function serveStatic(request: IncomingMessage, response: ServerResponse, urlPath: string): void {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const full = join(DIST_DIR, relative);
  if (!full.startsWith(DIST_DIR) || !existsSync(full)) {
    json(response, 404, { error: `nothing serves ${urlPath}. Did you run npm run console:build?` });
    return;
  }
  let text = readFileSync(full, 'utf8');
  if (extname(full) === '.html') {
    text = text.replace('<meta name="forge-token" content="" />', `<meta name="forge-token" content="${TOKEN}" />`);
  }
  const mime = MIME[extname(full)] ?? 'application/octet-stream';
  response.writeHead(200, { 'content-type': mime });
  response.end(text);
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

const sockets = new Set<Duplex>();

function publish(event: Record<string, unknown>): void {
  const frame = textFrame(JSON.stringify(event));
  for (const socket of [...sockets]) {
    try {
      socket.write(frame);
    } catch {
      sockets.delete(socket);
    }
  }
}

export function createStubServer() {
  const server = createServer((request, response) => {
    const urlPath = (request.url ?? '/').split('?')[0] ?? '/';

    if (urlPath === '/state' && request.method === 'GET') {
      json(response, 200, stateNow());
      return;
    }
    if (urlPath === '/inbox' && request.method === 'GET') {
      json(response, 200, inbox);
      return;
    }
    if (urlPath === '/answer' && request.method === 'POST') {
      void readBody(request).then((raw) => {
        let parsed: { key?: string; answer?: string };
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          json(response, 400, { error: 'the body was not JSON' });
          return;
        }
        if (!parsed.key || parsed.answer === undefined) {
          json(response, 400, { error: 'an answer needs a key and an answer' });
          return;
        }
        const found = inbox.open.find((entry) => entry.key === parsed.key);
        if (!found) {
          json(response, 404, { error: `nothing asked ${parsed.key}` });
          return;
        }
        const answered: InboxEntry = { ...found, answer: parsed.answer, answeredAt: Date.now() };
        inbox = { open: inbox.open.filter((entry) => entry.key !== parsed.key), all: inbox.all };
        publish({ event: 'ask.answered', key: answered.key, runs: answered.runs });
        json(response, 200, answered);
      });
      return;
    }
    if (urlPath === '/stop' && request.method === 'POST') {
      publish({ event: 'run.parked', actor: 'console' });
      json(response, 200, { stopped: ['card-network-glow', 'withdrawal-fee'] });
      return;
    }
    if (urlPath === '/send' && request.method === 'POST') {
      json(response, 200, { ok: true });
      return;
    }
    if (urlPath === '/clear' && request.method === 'POST') {
      json(response, 200, { ok: true });
      return;
    }

    serveStatic(request, response, urlPath);
  });

  server.on('upgrade', (request, socket) => {
    const duplex = socket as Duplex;
    const urlPath = (request.url ?? '/').split('?')[0];
    const key = request.headers['sec-websocket-key'];
    if (urlPath !== '/events' || typeof key !== 'string') {
      duplex.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    duplex.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
      + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(duplex);
    duplex.on('close', () => sockets.delete(duplex));
  });

  return server;
}

// Guarded so importing this module for a test never starts a listening server.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createStubServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`forge console stub: http://127.0.0.1:${PORT} (token ${TOKEN})`);
  });
}
