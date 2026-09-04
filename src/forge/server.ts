/**
 * What a board reads, and how it hears about changes.
 *
 * Four routes and one stream on 4120. `/state` is the fleet as it is now, with the three
 * numbers the old dashboard could never show: which model a lane is on, how much context
 * it is carrying, and what it is costing per hour. `/inbox` is what is waiting on a
 * person, `/answer` is how they reply, and `/events` pushes rather than being polled.
 *
 * Bound to loopback. This hands out the fleet's state and accepts answers that resume
 * runs, so binding it to every interface would put a control surface on the network.
 *
 * The websocket is implemented here rather than pulled in, because it only has to do one
 * thing: send server-to-client text frames. That is a handshake and a frame header, and a
 * dependency in a repository whose dependency policy is not mine to set costs more than
 * eighty lines.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Inbox } from './inbox.js';
import { replay } from './journal.js';
import type { Lanes, LaneRecord } from './supervisor.js';

export const FORGE_PORT = 4120;

/** The constant RFC 6455 requires in the handshake. Not a secret, just a ritual. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface ForgeServerOptions {
  lanes: Lanes;
  inbox: Inbox;
  journalPath: string;
  port?: number;
  host?: string;
}

export class ForgeServer {
  readonly host: string;

  readonly inbox: Inbox;

  private readonly lanes: Lanes;

  private readonly journalPath: string;

  private readonly wanted: number;

  private http: Server | undefined;

  private sockets = new Set<Duplex>();

  /**
   * Every socket the server has accepted, upgraded or not.
   *
   * `server.close()` waits for open connections, and a websocket is open by definition,
   * so without this the server never stops. `closeAllConnections` covers it on new
   * enough Node and silently does nothing on older, which is the worst of both.
   */
  private accepted = new Set<Duplex>();

  port = 0;

  constructor(options: ForgeServerOptions) {
    this.lanes = options.lanes;
    this.inbox = options.inbox;
    this.journalPath = options.journalPath;
    this.wanted = options.port ?? FORGE_PORT;
    this.host = options.host ?? '127.0.0.1';
  }

  get listeners(): number {
    return this.sockets.size;
  }

  async listen(): Promise<number> {
    const server = createServer((request, response) => this.route(request, response));
    server.on('connection', (socket) => {
      this.accepted.add(socket as unknown as Duplex);
      socket.on('close', () => this.accepted.delete(socket as unknown as Duplex));
    });
    server.on('upgrade', (request, socket) => this.upgrade(request, socket as Duplex));
    this.http = server;
    await new Promise<void>((resolve) => server.listen(this.wanted, this.host, resolve));
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : this.wanted;
    return this.port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.http;
    if (!server) return;
    // An upgraded connection keeps close() waiting forever, and a websocket is exactly
    // that, so every accepted socket is destroyed before the server is asked to stop.
    for (const socket of this.accepted) socket.destroy();
    this.accepted.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.http = undefined;
  }

  /**
   * The fleet as it is now.
   *
   * Lanes come from their files and the burn from the journal, which is the split that
   * keeps this honest: the lane record is what a worker last said about itself, and the
   * journal is what actually happened.
   */
  state(): Record<string, unknown> {
    const fleet = replay(this.journalPath);
    return {
      at: Date.now(),
      lanes: this.lanes.all().map((lane) => ({ ...lane, usd_per_hour: usdPerHour(lane) })),
      burn: fleet.burn,
      handoffs: fleet.handoffs,
      torn: fleet.torn,
      inbox_open: this.inbox.open().length,
    };
  }

  /** Send an event to every listener. A socket that has gone is dropped, never thrown on. */
  publish(event: Record<string, unknown>): void {
    const frame = textFrame(JSON.stringify(event));
    for (const socket of [...this.sockets]) {
      try {
        if (socket.writable) socket.write(frame);
        else this.sockets.delete(socket);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  private route(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? '/').split('?')[0];

    if (path === '/state' && request.method === 'GET') {
      return json(response, 200, this.state());
    }
    if (path === '/inbox' && request.method === 'GET') {
      return json(response, 200, { open: this.inbox.open(), all: this.inbox.all() });
    }
    if (path === '/answer') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'answering a question is not a safe method' });
      }
      return this.answer(request, response);
    }
    return json(response, 404, { error: `nothing serves ${path}` });
  }

  private answer(request: IncomingMessage, response: ServerResponse): void {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let parsed: { key?: string; answer?: string };
      try {
        parsed = JSON.parse(body) as { key?: string; answer?: string };
      } catch {
        // A body that will not parse is not an answer. Guessing what was meant here
        // would resume a run on a decision nobody made.
        json(response, 400, { error: 'the body was not JSON' });
        return;
      }
      if (!parsed.key || parsed.answer === undefined) {
        json(response, 400, { error: 'an answer needs a key and an answer' });
        return;
      }
      const answered = this.inbox.answer(parsed.key, parsed.answer);
      if (!answered) {
        json(response, 404, { error: `nothing asked ${parsed.key}` });
        return;
      }
      this.publish({ event: 'ask.answered', key: answered.key, runs: answered.runs });
      json(response, 200, answered);
    });
  }

  private upgrade(request: IncomingMessage, socket: Duplex): void {
    const path = (request.url ?? '/').split('?')[0];
    const key = request.headers['sec-websocket-key'];
    if (path !== '/events' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
      + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.sockets.add(socket);
    const drop = () => this.sockets.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
    socket.on('end', drop);
  }
}

/**
 * What a lane is costing per hour, from what it has spent and how long it has run.
 *
 * Zero before a lane has run long enough to divide by: a rate extrapolated from four
 * seconds is a number that looks like measurement and is not.
 */
function usdPerHour(lane: LaneRecord): number {
  if (!lane.started || !lane.cost_usd) return 0;
  const hours = (Date.now() - lane.started) / 3_600_000;
  if (hours < 1 / 120) return 0;
  return Number((lane.cost_usd / hours).toFixed(4));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * One unmasked text frame.
 *
 * Server frames are never masked, which removes the half of RFC 6455 that is fiddly. The
 * three length forms are all that is left.
 */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}
