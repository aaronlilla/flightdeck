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
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { Inbox } from './inbox.js';
import { JournalCache, type RangeReader } from './journal.js';
import type { StuckSignal } from './liveness.js';
import { killSwitchPath as defaultKillSwitchPath, registryDir, serverTokenPath } from './paths.js';
import { Registry } from './registry.js';
import { RunInbox, deliverAnswer } from './runinbox.js';
import { Breaker, clearKillSwitch, Fleet, type LaneRecord, type Lanes } from './supervisor.js';

/** Reads the server's own bearer token, minting one on first use. */
export function ensureServerToken(path: string = serverTokenPath()): string {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(path, token, 'utf8');
  return token;
}

/** The maximum a request body may be before it is refused outright. */
export const MAX_BODY_BYTES = 64 * 1024;

export const FORGE_PORT = 4120;

/** The constant RFC 6455 requires in the handshake. Not a secret, just a ritual. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const CONSOLE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * `dist/console/`, found by walking up from this file to the repository root instead of
 * assuming a fixed number of directory levels. Compiled, this file lives at
 * `dist/forge/server.js`, one level under the console's own `dist/console/`. Run straight
 * off source with `tsx`, it lives at `src/forge/server.ts`, two levels under
 * `src/console/`, and `dist/console/` still has to be reached through the repo root.
 * Walking up to the nearest `package.json` handles both cases without hard-coding either.
 */
function repoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

function defaultConsoleDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(repoRoot(here), 'dist', 'console');
}

export interface ForgeServerOptions {
  lanes: Lanes;
  inbox: Inbox;
  journalPath: string;
  port?: number;
  host?: string;
  /** What liveness currently has open. Defaults to reporting nothing stuck. */
  stuck?: () => StuckSignal[];
  /**
   * Every process liveness is watching, with its age and any trip. Defaults to empty.
   * `{ ok: false, reason }` when the process probe behind it failed -- kept as its own
   * shape rather than folded into the array, so a reader can tell "the probe is broken"
   * from "here is a process record" instead of field-sniffing an entry with no `pid`.
   */
  fleet?: () => Array<Record<string, unknown>> | { ok: false; reason: string };
  /** Overrides the token minted from `serverTokenPath()`. A specimen only. */
  token?: string;
  /** Overrides how the journal cache reads bytes off disk. A specimen only: it is how a
   *  test counts exactly what a second /state read actually touched. */
  journalRangeReader?: RangeReader;
  /** Shares an already-built cache with a caller reading the same journal (the 30-second
   *  liveness tick in `cli.ts`), instead of each keeping its own offset and re-folding
   *  bytes the other has already read. Takes precedence over `journalRangeReader`. */
  journalCache?: JournalCache;
  /** Overrides where `/stop` and `/clear --all` read and write the kill switch. Defaults
   *  to `killSwitchPath()`, which itself follows `FORGE_HOME`. A specimen only. */
  killSwitchFile?: string;
  /** What `/stop` reads to find a live run (P4.7/I8: registry rows, never lane records).
   *  Defaults to a fresh `Registry` over `registryDir()`, which itself follows
   *  `FORGE_HOME`. A specimen overrides this to admit its own fixture rows. */
  registry?: Registry;
  /** Overrides where `/` serves the built console from. Defaults to `dist/console/`
   *  found by walking up to the repo root. A specimen only. */
  consoleDistDir?: string;
}

export class ForgeServer {
  readonly host: string;

  readonly inbox: Inbox;

  /** The bearer token `/answer`, `/stop`, `/send` and `/clear` require, in the
   *  `X-Forge-Token` header. */
  readonly token: string;

  private readonly lanes: Lanes;

  private readonly journalPath: string;

  private readonly journalCache: JournalCache;

  private readonly killSwitchFile: string;

  private readonly registry: Registry;

  private readonly consoleDistDir: string;

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

  private readonly stuckFn: () => StuckSignal[];

  private readonly fleetFn: () => Array<Record<string, unknown>> | { ok: false; reason: string };

  constructor(options: ForgeServerOptions) {
    this.lanes = options.lanes;
    this.inbox = options.inbox;
    this.journalPath = options.journalPath;
    this.journalCache = options.journalCache ?? new JournalCache(options.journalRangeReader);
    this.wanted = options.port ?? FORGE_PORT;
    this.host = options.host ?? '127.0.0.1';
    this.stuckFn = options.stuck ?? (() => []);
    this.fleetFn = options.fleet ?? (() => []);
    this.token = options.token ?? ensureServerToken();
    this.killSwitchFile = options.killSwitchFile ?? defaultKillSwitchPath();
    this.registry = options.registry ?? new Registry(registryDir());
    this.consoleDistDir = options.consoleDistDir ?? defaultConsoleDistDir();
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
   * journal is what actually happened. Every field but `at` carries its own
   * `verified_at`, read fresh from the thing that backs it (a lane's own file mtime, the
   * inbox directory's mtime) rather than a value cached in memory since the process
   * started. Each lane also carries its own `verified_at` for the same reason: the fleet
   * as a whole is only as current as its stalest lane.
   */
  state(): Record<string, unknown> {
    const fleet = this.journalCache.read(this.journalPath);
    const now = Date.now();

    const lanes = this.lanes.all().map((lane) => {
      const mtime = this.lanes.mtimeOf(lane.slug) ?? now;
      const run = fleet.runs[lane.slug];
      const lastEventAt = run?.lastEventAt || mtime;
      return {
        ...lane,
        // The journal is updated on every turn; the lane file only at the end of a
        // session chain. Once a run has taken at least one turn, its journaled context is
        // the fresher number; before that, the run's own default (0) would incorrectly
        // overwrite whatever the lane file still remembers from an earlier session.
        context: run && run.turns > 0 ? run.context : lane.context,
        usd_per_hour: usdPerHour(lane),
        verified_at: mtime,
        last_event_age_s: Math.max(0, Math.round((now - lastEventAt) / 1000)),
        current_tool: run?.currentTool ?? null,
      };
    });

    // Everything the journal backs is stamped from the journal file's own mtime, a real
    // source read, never Date.now(): a verified_at that only ever equals "now" is not a
    // freshness claim, it is the request time wearing one. stuck and fleet have no file
    // behind them at all -- they are computed fresh on every call from a live process
    // scan -- so they carry observed_at instead, honestly naming what they are: seen just
    // now, not read from something that was written down.
    const journalMtime = existsSync(this.journalPath) ? statSync(this.journalPath).mtimeMs : now;

    return {
      at: now,
      lanes: { value: lanes, verified_at: now },
      burn: { value: fleet.burn, verified_at: journalMtime },
      handoffs: { value: fleet.handoffs, verified_at: journalMtime },
      torn: { value: fleet.torn, verified_at: journalMtime },
      inbox_open: { value: this.inbox.open().length, verified_at: this.inbox.mtime() ?? now },
      stuck: { value: this.stuckFn(), observed_at: now },
      fleet: { value: this.fleetFn(), observed_at: now },
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
    const path = (request.url ?? '/').split('?')[0] ?? '/';

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
    if (path === '/stop') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'stopping the fleet is not a safe method' });
      }
      return this.stop(request, response);
    }
    if (path === '/send') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'sending to a run is not a safe method' });
      }
      return this.send(request, response);
    }
    if (path === '/clear') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'clearing a lane is not a safe method' });
      }
      return this.clearLane(request, response);
    }
    if (request.method === 'GET') {
      return this.serveStatic(path, response);
    }
    return json(response, 404, { error: `nothing serves ${path}` });
  }

  /**
   * A request's Origin, allowed only when it names this server itself or is absent
   * entirely (a `curl`, a script, `forge answer` itself -- none of which set one). Any
   * other Origin is a browser tab on some other page reaching for a local port, which is
   * exactly the CSRF this control exists to refuse.
   */
  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    return origin === `http://${this.host}:${this.port}` || origin === `http://127.0.0.1:${this.port}`;
  }

  /**
   * The Origin and token checks every mutating route needs. Written as the console's own
   * `<meta name="forge-token">` plus this same code path on `/answer`, `/stop`, `/send`
   * and `/clear`, so there is exactly one place that decides whether a write is allowed.
   */
  private authorized(request: IncomingMessage, response: ServerResponse): boolean {
    if (!this.originAllowed(request)) {
      json(response, 403, { error: 'that origin is not this server' });
      return false;
    }
    if (request.headers['x-forge-token'] !== this.token) {
      json(response, 401, { error: 'missing or wrong X-Forge-Token' });
      return false;
    }
    return true;
  }

  /**
   * Reads a request body up to `MAX_BODY_BYTES`, parses it as JSON, and hands the result
   * to `handle`. A body over the limit or one that will not parse answers for itself and
   * `handle` is never called: guessing what a broken write meant is how a run gets resumed
   * on a decision nobody made.
   */
  private readJson<T>(request: IncomingMessage, response: ServerResponse, handle: (parsed: T | null) => void): void {
    let body = '';
    let overLimit = false;
    request.on('data', (chunk: Buffer) => {
      if (overLimit) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        overLimit = true;
        json(response, 413, { error: `body over ${MAX_BODY_BYTES} bytes` });
        request.destroy();
      }
    });
    request.on('end', () => {
      if (overLimit) return;
      let parsed: T | null;
      try {
        parsed = body ? JSON.parse(body) as T : null;
      } catch {
        json(response, 400, { error: 'the body was not JSON' });
        return;
      }
      handle(parsed);
    });
  }

  private answer(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ key?: string; answer?: string }>(request, response, (parsed) => {
      void (async () => {
        if (!parsed || !parsed.key || parsed.answer === undefined) {
          json(response, 400, { error: 'an answer needs a key and an answer' });
          return;
        }
        const answered = this.inbox.answer(parsed.key, parsed.answer);
        if (!answered) {
          json(response, 404, { error: `nothing asked ${parsed.key}` });
          return;
        }
        // Same delivery cli.ts's `forge answer` uses: writing the inbox entry alone does
        // not resume anything. This process holds no live SdkEngine to answer in place
        // (that path is the CLI's, when it happens to share a process with the run), so
        // this always rides the cross-process inbox queue.
        await deliverAnswer(answered, parsed.key, parsed.answer);
        this.publish({ event: 'ask.answered', key: answered.key, runs: answered.runs });
        json(response, 200, answered);
      })();
    });
  }

  /**
   * `POST /stop`: the console's Stop all button, wired to the same `Fleet.stopAll` that
   * `forge stop --all` runs from a terminal. Parks every running lane with a handoff
   * request and engages the kill switch; safe to call on an idle fleet.
   */
  private stop(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ reason?: string }>(request, response, (parsed) => {
      void (async () => {
        const reason = parsed?.reason || 'stopped from the console';
        const { stopped, stale } = await new Fleet(
          this.lanes, this.registry, this.journalPath, this.killSwitchFile,
        ).stopAll(reason);
        for (const outcome of stopped) {
          this.publish({ event: 'run.parked', run: outcome.slug, actor: 'console', reached: outcome.reached });
        }
        json(response, 200, { stopped: stopped.map((outcome) => outcome.slug), stale });
      })();
    });
  }

  /**
   * `POST /send`: queues a message into a run's own inbox, the same `RunInbox.send` that
   * `forge send RUN TEXT` calls. Delivered by the run's next tool call, per `runinbox.ts`.
   */
  private send(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ run?: string; text?: string }>(request, response, (parsed) => {
      if (!parsed || !parsed.run || !parsed.text) {
        json(response, 400, { error: 'a send needs a run and text' });
        return;
      }
      new RunInbox(parsed.run).send(parsed.text, 'console');
      json(response, 200, { ok: true });
    });
  }

  /**
   * `POST /clear`: `{ lane }` hands one breaker-blocked lane back the way `forge clear
   * LANE` does; `{ all: true }` clears the kill switch the way `forge clear --all` does.
   */
  private clearLane(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ lane?: string; all?: boolean }>(request, response, (parsed) => {
      if (parsed?.all === true) {
        clearKillSwitch(this.killSwitchFile);
        json(response, 200, { ok: true });
        return;
      }
      if (!parsed || !parsed.lane) {
        json(response, 400, { error: 'a clear needs a lane or { all: true }' });
        return;
      }
      new Breaker(this.lanes).clear(parsed.lane);
      json(response, 200, { ok: true });
    });
  }

  /**
   * The built console at `dist/console/`, decision 1 in the goal brief: served at `/` on
   * this same port rather than a second process. `index.html`'s empty
   * `<meta name="forge-token">` is filled in with this server's real token as the file is
   * served, never written back to disk, so the token that reaches a browser always
   * matches the process answering it.
   */
  private serveStatic(urlPath: string, response: ServerResponse): void {
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
    const full = join(this.consoleDistDir, relative);
    if (!full.startsWith(this.consoleDistDir) || !existsSync(full)) {
      json(response, 404, { error: `nothing serves ${urlPath}. Did you run npm run console:build?` });
      return;
    }
    let text = readFileSync(full, 'utf8');
    if (extname(full) === '.html') {
      text = text.replace(
        '<meta name="forge-token" content="" />',
        `<meta name="forge-token" content="${this.token}" />`,
      );
    }
    const mime = CONSOLE_MIME[extname(full)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': mime });
    response.end(text);
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
