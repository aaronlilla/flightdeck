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

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realNodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { ConsoleReads } from './console/reads.js';
import type { CodexAdvisor as CodexAdvisorLike } from './council/codexAdvisor.js';
import { HEARTBEAT_MS, type BlockerKind } from '../shared/console-model.js';
import { sliceEvent, sliceEventsFor } from '../shared/console-events.js';
import { Narrator } from './console/narrate-store.js';
import { reasonerFor } from './reasoner-claude.js';

/** How often the fleet journal's size is compared against the last look. */
const JOURNAL_WATCH_MS = 1000;
import { appendThread, ConsoleWrites, plainReceiptCard } from './console/command.js';
import { QueueRoutes } from './console/queue-route.js';
import { BlockersRoutes, type Confirmer, type Restarter } from './console/blockers-route.js';
import { IntegrationsConnectRoutes } from './console/integrations-route.js';
import type { DetectionInputs } from './console/blockers.js';
import { gatherBlockers } from './console/blockers-gather.js';
import { buildConfirmers } from './console/blockers-confirm.js';
import { buildRestarters } from './console/blockers-restart.js';
import { resumeRun } from './console/run-actions.js';
import { runtimeVersion } from './launcher.js';
import { readQueuePaused, writeQueuePaused } from './console/queue-pause.js';
import { writeQueueWidth } from './console/queue-width.js';
import type { Actuator, Reasoner } from './contracts.js';
import { isAskStale, projectStaleness, type Inbox } from './inbox.js';
import { appendOnce, Journal, JournalCache, type RangeReader } from './journal.js';
import type { StuckSignal } from './liveness.js';
import { WardenActuator } from './warden.js';
import { QueueStore } from './intake/queueStore.js';
import { mergeItem, type QueueMergeDeps, type QueuePromoteDeps, type QueueTicketSearch } from './intake/queue.js';
import {
  forgeHome, killSwitchPath as defaultKillSwitchPath, packetsDir as defaultPacketsDir, queuePath as defaultQueuePath,
  registryDir, serverTokenPath,
} from './paths.js';
import { routerEnabled } from './policy.js';
import { retireFinished, retireLane, retirePreview, retiredPath, type RetireLaneDeps } from './console/retire.js';
import { mergeReadyReportFrom } from './console/lanes.js';
import { chainStatusRows, foldChainState } from './chain.js';
import { processAlive, Registry } from './registry.js';
import { route as routeMessage } from './router.js';
import { RunInbox, deliverAnswer } from './runinbox.js';
import { assertRunListening } from './console/listening.js';
import { amendRunBrief, type AmendDeps } from './console/amend.js';
import { ConductorAgent } from './console/agent.js';
import { RoundsRoutes } from './console/rounds-route.js';
import type { QueryFn } from '../adapter/engine.js';
import { conductorAgentEnabled, reasonerTimeoutMsFor } from './policy.js';
import { CONDUCTOR_CLASS } from './console/agent.js';
import { Breaker, clearKillSwitch, Fleet, type LaneRecord, type Lanes } from './supervisor.js';

/** Reads the server's own bearer token, minting one on first use. */
export function ensureServerToken(path: string = serverTokenPath()): string {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(path, token, 'utf8');
  return token;
}

export { appendAmendment } from './console/amend.js';

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
  /** Overrides where `GET /run/:id` reads a handoff packet from. Defaults to
   *  `packetsDir()`, which itself follows `FORGE_HOME`. A specimen only. */
  packetsDir?: string;
  /** H1.7: overrides where `POST /run/:id/retire` and `POST /retire-finished` write the
   *  console's own retired-lane log. Defaults to `forgeHome()`, which follows
   *  `FORGE_HOME`. A specimen only. */
  forgeHomeDir?: string;
  /** X4: what `POST /router` calls to classify and act on a message. No default is
   *  wired: `router.enabled` in the model policy is `false` out of the box, and
   *  `/router` never reaches this at all while it is off, so a real implementation
   *  has nothing to answer for in this cut. A specimen hands this a fake; anything
   *  else that constructs a `ForgeServer` with the router turned on must supply one
   *  or `POST /router` answers 501 rather than throwing. */
  reasoner?: Reasoner;
  /** Overrides the console's read routes (`/lanes`, `/thread`, `/journal`, `/caps`,
   *  `/proposals`, `/run/:id/{thread,pr,sandbox}`). A specimen only: production always
   *  gets the default, which reads the real `~/.forge` tree. */
  consoleReads?: ConsoleReads;
  /** R-55: `POST /codex/ask` and `GET /codex/:id`, behind the same token as every other
   *  route. Undefined (no default wired -- the advisor spends Codex quota, and this
   *  goal's guardrail is "nothing else live") answers 501, the same pattern `/router`
   *  uses above when its own dependency is unset. */
  codexAdvisor?: CodexAdvisorLike;
  /** What every console write (`ConsoleWrites`) drives kill/pause/resume through.
   *  Defaults to a real `WardenActuator` over this server's own journal, registry and
   *  lanes. A specimen overrides this with a fake, per this stream's rule that a test
   *  never signals a real process. */
  consoleActuator?: Actuator;
  /** Where `GET`/`POST /caps` and `POST /run/:id/cap` read and write the Governor's
   *  budget. Defaults to `policyPath()`, which -- unlike every other Forge path here --
   *  does not follow `FORGE_HOME`, so a specimen always sets this or a caps read/write
   *  reaches this repo's own tracked `model-policy.json`. */
  modelPolicyPath?: string;
  /** Overrides the intake queue's own log. Defaults to `queuePath()`, which follows
   *  `FORGE_HOME`. A specimen only. */
  queueStore?: QueueStore;
  /** What `POST /queue` resolves a `query`/`backlog` add's JQL through. Defaults to a
   *  function that always refuses with the missing-credential message requirement 2
   *  asks for -- `forge up`'s own wiring (`queue-wire.ts#queueSearch`) is what a real
   *  Jira credential makes reachable; this class never builds one itself. */
  queueSearch?: QueueTicketSearch;
  /** How many queue items `GET /queue` reports as the worker's own concurrency ceiling.
   *  Purely informational here -- the worker enforces it, this class only echoes it. */
  queueMaxInFlight?: number;
  /** A.7: the Merge click's dependencies (`queue-wire.ts#queueMergeDeps`). Absent means
   *  `POST /queue/:id/merge` answers 501 with that reason, which is what a console with
   *  no chain environment should say. */
  queueMergeDeps?: QueueMergeDeps;
  /** A.7: the Promote click's dependencies (`queue-wire.ts#queuePromoteDeps`). */
  queuePromoteDeps?: QueuePromoteDeps;
  /** Overrides `GET /blockers`'s own live-fact reader. Defaults to `gatherBlockers`
   *  (`blockers-gather.ts`) wired against this server's own inbox, integrations, lane
   *  view, registry and queue store. A specimen only. */
  blockersGather?: () => Promise<DetectionInputs>;
  /** The Conductor agent's SDK `query`, or a fake. A specimen always sets this;
   *  production leaves it unset and the agent opens a real session on the fleet
   *  account. `conductorIdleMs` overrides the five-minute idle close. */
  conductorQueryFn?: QueryFn;
  conductorIdleMs?: number;
  /** Overrides the Blockers view's own confirmers. Defaults to `buildConfirmers`
   *  (`blockers-confirm.ts`). A specimen only. */
  blockersConfirmers?: Partial<Record<BlockerKind, Confirmer>>;
  /** Overrides the Blockers view's own restarters. Defaults to `buildRestarters`
   *  (`blockers-restart.ts`). A specimen only. */
  blockersRestarters?: Partial<Record<BlockerKind, Restarter>>;
  /** Overrides where the Blockers view's own durable ledger lives. Defaults to
   *  `blockersLedgerPath()`, which follows `FORGE_HOME`. A specimen only. */
  blockersLedgerPath?: string;
  /** Overrides the liveness ticker's own process probe (`processAlive` by default). A
   *  specimen only -- production always asks the real process table. */
  isAlive?: (pid: number) => boolean;
  /** How often the liveness ticker re-checks a lane it last saw alive, in ms. Defaults
   *  to 2000 (the "very live" board's own cadence). A specimen sets this low with fake
   *  timers rather than waiting on the real interval. */
  liveTickMs?: number;
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

  private readonly packetsDirPath: string;

  private readonly forgeHomeDir: string;

  private readonly modelPolicyPathOpt: string | undefined;

  private readonly reasoner: Reasoner | undefined;

  private readonly codexAdvisorDep: CodexAdvisorLike | undefined;

  private readonly narrator: Narrator;

  private readonly consoleReads: ConsoleReads;

  private readonly wanted: number;

  private http: Server | undefined;

  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  private journalWatchTimer: ReturnType<typeof setInterval> | undefined;

  private journalSizeSeen = -1;
  private liveTimer: ReturnType<typeof setInterval> | undefined;

  private readonly isAliveFn: (pid: number) => boolean;

  private readonly liveTickMs: number;

  /** Every run this ticker has last seen alive or dead, so a re-check only fires the
   *  cheap pid probe for a lane it already believed was live, and a flip publishes
   *  exactly once instead of every tick. Undefined (never checked yet) is neither: the
   *  first tick over a row establishes its baseline silently. */
  private readonly liveKnown = new Map<string, boolean>();

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

  /** Every console write (`src/forge/console/command.ts`'s `ConsoleWrites`), plus
   *  `GET /integrations`, which that module owns despite being a read. */
  private readonly consoleWrites: ConsoleWrites;

  private readonly queueRoutes: QueueRoutes;

  private readonly blockersRoutes: BlockersRoutes;

  /** `POST /integrations/:id/connect` and `GET /integrations/:id/connect/:attempt`
   *  (`src/forge/console/integrations-route.ts`) -- M owns `integrations.ts` outright;
   *  these two routes never touch `command.ts`. */
  private readonly integrationsConnectRoutes: IntegrationsConnectRoutes;

  /** The Conductor's rounds behind `GET /rounds` / `POST /rounds/apply` and its ticker. */
  readonly rounds: RoundsRoutes;

  /** The Conductor agent behind `POST /command` (`console/agent.ts`). */
  readonly conductor: ConductorAgent;
  /** The Jira project's own name, read once from `/rest/api/3/project/<key>` when the
   *  Jira credentials are set; `null` until then and when they are not. */
  private projectName: string | null = null;

  private readonly queueStoreForMerge: QueueStore;

  private readonly queueMergeDepsOpt: QueueMergeDeps | undefined;
  /** Set by `forge up` once the self loop exists; read fresh on every `/state`. */
  selfStatus: (() => unknown) | undefined;

  constructor(options: ForgeServerOptions) {
    this.lanes = options.lanes;
    this.inbox = options.inbox;
    this.journalPath = options.journalPath;
    this.journalCache = options.journalCache ?? new JournalCache(options.journalRangeReader);
    this.wanted = options.port ?? Number(process.env['FORGE_PORT'] ?? FORGE_PORT);
    this.host = options.host ?? '127.0.0.1';
    this.stuckFn = options.stuck ?? (() => []);
    this.fleetFn = options.fleet ?? (() => []);
    this.token = options.token ?? ensureServerToken();
    this.killSwitchFile = options.killSwitchFile ?? defaultKillSwitchPath();
    this.registry = options.registry ?? new Registry(registryDir());
    this.isAliveFn = options.isAlive ?? processAlive;
    this.liveTickMs = options.liveTickMs ?? 2_000;
    this.consoleDistDir = options.consoleDistDir ?? defaultConsoleDistDir();
    this.packetsDirPath = options.packetsDir ?? defaultPacketsDir();
    this.forgeHomeDir = options.forgeHomeDir ?? forgeHome();
    this.modelPolicyPathOpt = options.modelPolicyPath;
    this.reasoner = options.reasoner;
    this.codexAdvisorDep = options.codexAdvisor;
    // The narrator is the server's own, not the router's: it runs on the `narrate`
    // class, its cap is its own, and a console with no router still narrates. Nothing
    // here is awaited by a route -- `Narrator.get` answers from cache or serves the
    // template and queues the call behind the response.
    this.narrator = new Narrator({
      reasoner: reasonerFor('claude', {
        journal: new Journal(this.journalPath),
        cwd: process.cwd(),
        ...(options.modelPolicyPath ? { policyPath: options.modelPolicyPath } : {}),
      }),
      journal: new Journal(this.journalPath),
      home: this.forgeHomeDir,
      ...(options.modelPolicyPath ? { policyPath: options.modelPolicyPath } : {}),
      publish: (slice, reason, ref) => { this.publish(sliceEvent(slice, reason, ref)); },
    });
    this.consoleReads = options.consoleReads
      ?? new ConsoleReads({
        narrator: this.narrator,
        ...(options.modelPolicyPath ? { modelPolicyPath: options.modelPolicyPath } : {}),
      });
    this.queueStoreForMerge = options.queueStore ?? new QueueStore(defaultQueuePath());
    this.consoleWrites = new ConsoleWrites({
      journalPath: this.journalPath,
      registry: this.registry,
      lanes: this.lanes,
      inbox: this.inbox,
      actuator: options.consoleActuator ?? new WardenActuator({
        journal: new Journal(this.journalPath), journalPath: this.journalPath,
        registry: this.registry, lanes: this.lanes,
      }),
      authorized: (request, response) => this.authorized(request, response),
      stuck: this.stuckFn,
      lanesView: () => this.consoleReads.lanesResponse(),
      lanesViewAll: () => this.consoleReads.lanesResponse(true, true),
      forgeHomeDir: this.forgeHomeDir,
      queueStore: this.queueStoreForMerge,
      // R-53: under the flag, a service in Session 0 cannot open a browser, so the
      // account-login spawn `realSpawnLogin` would otherwise make is intercepted here
      // and turned into a published event the desktop login helper answers instead.
      // Every other spawn `ConsoleWrites` makes (probe, logout, anything else) passes
      // straight through to the real `child_process.spawn` unchanged.
      ...(process.env['FORGE_LOGIN_HELPER'] === '1'
        ? { spawnFn: this.loginHelperSpawnFn() }
        : {}),
      ...(options.modelPolicyPath ? { modelPolicyPath: options.modelPolicyPath } : {}),
    });
    this.queueMergeDepsOpt = options.queueMergeDeps;
    // Queue-throughput W2: an explicit `queueMaxInFlight` (from `FORGE_QUEUE_MAX_IN_FLIGHT`
    // via cli.ts, or a test's own option) seeds the on-disk width every time this server
    // starts, the same "options.foo ?? default" precedence every other option here follows.
    // A later `POST /queue/width` still wins for the rest of this process's life --
    // `response()` and the ticker both read the file fresh, never this captured option.
    if (options.queueMaxInFlight !== undefined) writeQueueWidth(options.queueMaxInFlight);
    this.queueRoutes = new QueueRoutes({
      narrator: this.narrator,
      store: this.queueStoreForMerge,
      search: options.queueSearch ?? {
        searchKeys: async () => {
          throw new Error('jira not configured: missing FORGE_JIRA_SITE, FORGE_JIRA_EMAIL, FORGE_JIRA_TOKEN');
        },
      },
      authorized: (request, response) => this.authorized(request, response),
      readPaused: () => readQueuePaused(),
      writePaused: (paused) => writeQueuePaused(paused),
      maxInFlight: options.queueMaxInFlight ?? 4,
      publish: (event) => this.publish(event),
      confirmGate: (body, source, blast, act) => this.consoleWrites.confirmGate(body, source, blast, act),
      ...(options.queueMergeDeps ? { mergeDeps: options.queueMergeDeps } : {}),
      ...(options.queuePromoteDeps ? { promoteDeps: options.queuePromoteDeps } : {}),
    });
    this.conductor = new ConductorAgent({
      writes: this.consoleWrites, reads: this.consoleReads, queue: this.queueRoutes,
      amend: this.amendDeps(), inbox: this.inbox, journalPath: this.journalPath,
      publish: (event) => this.publish(event),
      rounds: { sheet: () => this.rounds.sheet(), apply: () => this.rounds.apply() },
      ...(options.conductorQueryFn ? { queryFn: options.conductorQueryFn } : {}),
      ...(options.modelPolicyPath ? { policyPath: options.modelPolicyPath } : {}),
      ...(options.conductorIdleMs !== undefined ? { idleMs: options.conductorIdleMs } : {}),
    });
    this.consoleWrites.attachAgent(this.conductor);
    this.rounds = new RoundsRoutes({
      store: this.queueStoreForMerge,
      lanesAll: () => this.consoleReads.lanesResponse(true, true).lanes,
      blockers: async () => (await this.blockersRoutes.list()).blockers,
      retireDeps: () => this.retireLaneDeps(),
      journalPath: this.journalPath,
      authorized: (request, response) => this.authorized(request, response),
      publish: (event) => this.publish(event),
      appendThread: (message) => appendThread(message),
      askConductor: (text) => this.conductor.handle(text),
      ...(options.modelPolicyPath ? { policyPath: options.modelPolicyPath } : {}),
    });
    this.integrationsConnectRoutes = new IntegrationsConnectRoutes({
      authorized: (request, response) => this.authorized(request, response),
      registry: this.consoleWrites.integrationsRegistry(),
      publish: (event) => this.publish(event),
    });
    this.blockersRoutes = new BlockersRoutes({
      narrator: this.narrator,
      journalPath: this.journalPath,
      authorized: (request, response) => this.authorized(request, response),
      ...(options.blockersLedgerPath ? { ledgerPath: options.blockersLedgerPath } : {}),
      gather: options.blockersGather ?? gatherBlockers({
        inbox: this.inbox, integrations: this.consoleWrites.integrationsRegistry(),
        lanesView: () => this.consoleReads.lanesResponse(true, false), registry: this.registry,
        queueStore: this.queueStoreForMerge,
      }),
      confirmers: options.blockersConfirmers ?? buildConfirmers({
        inbox: this.inbox, integrations: this.consoleWrites.integrationsRegistry(),
        registry: this.registry, queueStore: this.queueStoreForMerge,
      }),
      restarters: options.blockersRestarters ?? buildRestarters({
        queueStore: this.queueStoreForMerge, lanesView: () => this.consoleReads.lanesResponse(true, false),
        resumeRun: async (laneId) => {
          const outcome = await resumeRun(laneId, this.consoleWrites.runActionsDeps());
          return { ok: outcome.status === 200 };
        },
        appendReceipt: (text) => appendThread(plainReceiptCard(text)),
      }),
    });
  }

  get listeners(): number {
    return this.sockets.size;
  }

  /** `FORGE_BACKLOG_PROJECT`'s name off Jira, once; a failed read leaves `null`. */
  private async readProjectName(): Promise<void> {
    const key = process.env['FORGE_BACKLOG_PROJECT'];
    const site = process.env['FORGE_JIRA_SITE'];
    const email = process.env['FORGE_JIRA_EMAIL'];
    const token = process.env['FORGE_JIRA_TOKEN'];
    if (!key || !site || !email || !token) return;
    try {
      const base = /^https?:\/\//.test(site) ? site : `https://${site}`;
      const response = await fetch(`${base.replace(/\/$/, '')}/rest/api/3/project/${encodeURIComponent(key)}`, {
        headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, accept: 'application/json' },
      });
      if (!response.ok) return;
      const body = await response.json() as { name?: unknown };
      if (typeof body.name === 'string') this.projectName = body.name;
    } catch {
      // Unreachable Jira leaves the name unknown; the chrome shows the key alone.
    }
  }

  async listen(): Promise<number> {
    void this.readProjectName();
    const server = createServer((request, response) => { void this.route(request, response); });
    server.on('connection', (socket) => {
      this.accepted.add(socket as unknown as Duplex);
      socket.on('close', () => this.accepted.delete(socket as unknown as Duplex));
    });
    server.on('upgrade', (request, socket) => this.upgrade(request, socket as Duplex));
    this.http = server;
    // A bind that fails (the port held by another process) rejects here, so `forge up`
    // exits with that reason instead of running its timers against a port it never got.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.wanted, this.host, () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : this.wanted;
    // The console's own freshness contract (`VERIFIED_WINDOW_MS`, `console-model.ts`):
    // a value is "verified" only while a heartbeat under 15s old is arriving, so a
    // client with nothing else to poll still needs to hear from this process every 5s
    // to know the feed itself is alive, distinct from any one lane going quiet.
    this.heartbeatTimer = setInterval(() => this.publish({ type: 'heartbeat', at: Date.now() }), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
    // A run starting, ending or parking is written to the fleet journal by whichever
    // process runs it (a chain ticker, a queue worker, the warden), never through a
    // route here. The journal's size is the one signal that covers them all: when it
    // grows, the lanes and journal slices are stale and every listener hears so.
    this.journalSizeSeen = this.journalSize();
    this.journalWatchTimer = setInterval(() => {
      const size = this.journalSize();
      if (size === this.journalSizeSeen) return;
      this.journalSizeSeen = size;
      this.publish(sliceEvent('lanes', 'the fleet journal grew'));
      this.publish(sliceEvent('journal', 'the fleet journal grew'));
    }, JOURNAL_WATCH_MS);
    this.journalWatchTimer.unref?.();
    // The "very live" board's own cadence (Aaron: "the second there's nothing working
    // it should stop"): every registry row this ticker last saw alive gets a fresh,
    // cheap pid check -- no journal replay -- and a flip publishes `lane.live` so the
    // console refreshes inside 2s instead of waiting on the 5s poll.
    this.liveTimer = setInterval(() => this.tickLiveness(), this.liveTickMs);
    this.liveTimer.unref?.();
    this.rounds.start();
    this.consoleWrites.start();
    return this.port;
  }

  /** The liveness ticker's own body, pulled out so a test can fire one tick directly
   *  under fake timers rather than waiting on the real interval. Production never
   *  calls this itself. */
  private tickLiveness(): void {
    for (const row of this.registry.all()) {
      const was = this.liveKnown.get(row.goal);
      const alive = this.isAliveFn(row.pid);
      this.liveKnown.set(row.goal, alive);
      if (was === undefined) continue; // first sighting: establish the baseline, no flip to report
      if (was !== alive) this.publish({ event: 'lane.live', run: row.goal, alive, at: Date.now() });
    }
  }

  /** Test seam only: fires one liveness tick synchronously. Production relies on the
   *  real `setInterval` from `listen()`. */
  tickLivenessForTest(): void {
    this.tickLiveness();
  }

  async close(): Promise<void> {
    this.rounds.stop();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.journalWatchTimer) {
      clearInterval(this.journalWatchTimer);
      this.journalWatchTimer = undefined;
    }
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = undefined;
    }
    this.consoleWrites.stop();
    await this.conductor.stop();
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
   * F2: the terminal `run_state` of a lane's whole handoff chain, trusted as "still
   * running" only when a registry row backs some link in it.
   *
   * `fleet.runs[baseKey]` is that key's own last journal line and nothing more: once a
   * run hands off, its base key never gets another event, so `run.state` sits on
   * `'handed-off'` forever even after every successor has finished, crashed or been
   * cleared. This walks `successor` down to the chain's last journaled link and checks
   * every link along the way for a registry row (a live launch is not always the base
   * key -- a successor can be started directly by its own name). A `'handed-off'`
   * terminal with no live link anywhere in the chain is exactly the dead-chain case:
   * `undefined` here so `categoryOf`/`stateOf` fall through to the lane's own verdict,
   * the way a `'finished'` or `'parked'` terminal already does.
   */
  private chainRunState(
    runs: Record<string, { state?: string; successor?: string } | undefined>, baseKey: string,
  ): string | undefined {
    type Link = { state?: string; successor?: string };
    let node: Link | undefined = runs[baseKey];
    if (!node) return undefined;
    let live = Boolean(this.registry.get(baseKey));
    const seen = new Set([baseKey]);
    while (node?.successor && !seen.has(node.successor)) {
      const nextKey: string = node.successor;
      seen.add(nextKey);
      if (this.registry.get(nextKey)) live = true;
      const next: Link | undefined = runs[nextKey];
      if (!next) break;
      node = next;
    }
    if (node?.state === 'handed-off' && !live) return undefined;
    return node?.state;
  }

  /** Keeps only the entries a registry row or a lane file backs (I11). A journal fold
   *  creates an entry for any key an event names `run`, including a fleet pid a Warden
   *  tick only ever meant to report on; this is what keeps one of those off the board. */
  private registeredRunsOnly(runs: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(runs).filter(([key]) => Boolean(this.registry.get(key)) || Boolean(this.lanes.get(key))),
    );
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
      // The journal is updated on every turn; the lane file only at the end of a session
      // chain (and, for model/className, at admission). Once a run has taken at least one
      // turn, everything the journal tracks for it -- context, spend, class, model, and
      // its own lifecycle state -- is the fresher answer. Before that, the run's own
      // defaults would incorrectly overwrite whatever the lane file still remembers from
      // an earlier chain, which is exactly the bug a parked verdict sitting beside a live
      // "running Bash" tile came from: the tile was reading the lane's stale verdict
      // instead of the live run underneath it.
      const live = Boolean(run && run.turns > 0);
      const cost_usd = live ? run!.costUsd : lane.cost_usd;
      return {
        ...lane,
        context: live ? run!.context : lane.context,
        cost_usd,
        className: run?.className ?? lane.className ?? null,
        model: run?.model ?? lane.model,
        run_state: this.chainRunState(fleet.runs, lane.slug),
        usd_per_hour: usdPerHour({ ...lane, cost_usd }),
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
      // The contracts' own `ForgeStateSnapshot.runs`: the journal's live view of every
      // run it has ever seen a line for, keyed by run (today, one run per lane slug).
      // Not filtered to "still running" -- a finished or handed-off run stays visible so
      // a tile can tell a live run apart from a lane record with nothing under it. It is
      // filtered to a registry row or a lane file, though (I11): a fleet pid the Warden
      // reported on and nothing else is not a run, and a journal line naming it (a
      // `warden.health` row, or an older `warden.parked` one from before this fix) must
      // never surface here as one.
      runs: this.registeredRunsOnly(fleet.runs),
      // X4: read fresh on every call rather than cached at construction, so flipping
      // `router.enabled` in the policy file takes effect on the console's next poll
      // without restarting the server.
      router_enabled: routerEnabled(),
      // The Conductor agent (2026-09-08): whether the rail routes to it, and the class
      // timeout the client shows a "did not answer" row after. Read fresh, like
      // `router_enabled`, so a policy edit takes effect on the next poll.
      conductor: {
        enabled: conductorAgentEnabled(this.modelPolicyPathOpt),
        timeoutMs: reasonerTimeoutMsFor(CONDUCTOR_CLASS, this.modelPolicyPathOpt),
        open: this.conductor.open,
      },
      // C.3: read fresh on every call, same as router_enabled -- the desktop status
      // window and the console's top bar both need to say when the queue subsystem is
      // not running at all, distinct from a running queue that is merely paused.
      queue_on: process.env['FORGE_QUEUE'] === '1',
      build: runtimeVersion(),
      // The chrome's project label: the key this fleet works and, once Jira has answered
      // for it, its name. Absent when no project is configured.
      ...(process.env['FORGE_BACKLOG_PROJECT'] ? { project: { key: process.env['FORGE_BACKLOG_PROJECT'], name: this.projectName } } : {}),
      // The self loop's own count of what it found, queued and merged about this fleet
      // (`self-wire.ts`); absent when FORGE_SELF_REPO is unset.
      self: this.selfStatus?.() ?? null,
      // P5.7: the same rows `forge status` prints, folded fresh off the journal on
      // every call -- present whether or not FORGE_CHAIN is on, since a packet already
      // in flight still belongs on the console.
      chain: { value: chainStatusRows(foldChainState(fleet.events)), verified_at: journalMtime },
    };
  }

  private journalSize(): number {
    try {
      return statSync(this.journalPath).size;
    } catch {
      return 0;
    }
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

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    // The live spine: once a console write has been answered, every listener hears
    // which slices it touched and refetches those alone. One hook on the response
    // rather than a line in every handler, so a route added later cannot forget it;
    // `tests/forge/server-events.test.ts` walks every write and checks for the frame.
    response.once('finish', () => {
      const events = sliceEventsFor(request.method, path, response.statusCode);
      if (!events) return;
      for (const event of events) this.publish(event);
    });

    // The console's read routes (`/lanes`, `/thread`, `/journal`, `/caps`,
    // `/proposals`, `/run/:id/{thread,pr,sandbox}`): all of them require the token like
    // every route below except `/state`, checked here since `ConsoleReads` has no
    // access to this server's own `authorized()`.
    if (ConsoleReads.matches(path, request.method)) {
      if (!this.authorized(request, response)) return;
      if (await this.consoleReads.handle(path, request, response)) return;
    }

    // 2026-09-07: `POST /run/:id/recheck` -- the ticket sheet's own Re-check button.
    // Lives here rather than in `ConsoleReads` (GET-only) or `ConsoleWrites` (which has
    // no access to the reads side's own PR cache and drift wiring).
    const recheckMatch = /^\/run\/([^/]+)\/recheck$/.exec(path);
    if (recheckMatch && request.method === 'POST') {
      if (!this.authorized(request, response)) return;
      const id = decodeURIComponent(recheckMatch[1] as string);
      return json(response, 200, await this.consoleReads.runRecheckResponse(id));
    }

    if (path === '/state' && request.method === 'GET') {
      return json(response, 200, this.state());
    }
    if (path === '/inbox' && request.method === 'GET') {
      // F3: `stale`/`staleReason` computed fresh on every read, from the registry as it
      // is right now -- an ask's runs can all disappear with no new inbox event to say
      // so, so stamping this at write time would go stale itself.
      const hasRegistryRow = (run: string): boolean => Boolean(this.registry.get(run));
      return json(response, 200, {
        open: projectStaleness(this.inbox.open(), hasRegistryRow),
        all: projectStaleness(this.inbox.all(), hasRegistryRow),
      });
    }
    if (path.startsWith('/run/') && request.method === 'GET') {
      return this.runDetail(request, response, decodeURIComponent(path.slice('/run/'.length)));
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
    if (path === '/amend') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'amending a brief is not a safe method' });
      }
      return this.amend(request, response);
    }
    if (path === '/clear') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'clearing a lane is not a safe method' });
      }
      return this.clearLane(request, response);
    }
    if (path === '/router') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'routing a message is not a safe method' });
      }
      return this.routeMessage(request, response);
    }
    // R-53: the login helper's own progress post.
    if (path === '/accounts/connect/helper-result') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'posting a helper login result is not a safe method' });
      }
      return this.loginHelperResult(request, response);
    }
    // R-55: the Codex advisor, async so nothing here ever blocks a tick.
    if (path === '/codex/ask') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'asking Codex is not a safe method' });
      }
      return this.codexAsk(request, response);
    }
    const codexIdMatch = /^\/codex\/([^/]+)$/.exec(path);
    if (codexIdMatch && request.method === 'GET') {
      return this.codexStatusRoute(request, response, decodeURIComponent(codexIdMatch[1]!));
    }
    const retireMatch = /^\/run\/([^/]+)\/(retire|unretire)$/.exec(path);
    if (retireMatch) {
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'retiring a lane is not a safe method' });
      }
      return this.retireOne(request, response, decodeURIComponent(retireMatch[1]!), retireMatch[2] === 'retire');
    }
    if (path === '/retire-finished') {
      if (request.method === 'GET') return this.retireFinishedPreviewRoute(request, response);
      if (request.method !== 'POST') {
        return json(response, 405, { error: 'retiring lanes is not a safe method' });
      }
      return this.retireFinishedRoute(request, response);
    }
    if (path === '/merge-ready') {
      if (request.method === 'GET') return this.mergeReadyGet(request, response);
      if (request.method === 'POST') return this.mergeReadyPost(request, response);
      return json(response, 405, { error: 'merge-ready is GET or POST only' });
    }
    if (await this.consoleWrites.handle(path, request, response)) return;

    if (await this.integrationsConnectRoutes.handle(path, request, response)) return;
    if (await this.queueRoutes.handle(path, request, response)) return;
    if (await this.blockersRoutes.handle(path, request, response)) return;
    if (await this.rounds.handle(path, request, response)) return;
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

  /** R-55: `POST /codex/ask`, behind the token like every other route below. 501 when
   *  no advisor is wired (production default -- Codex spend is opt-in, per the
   *  guardrail's "nothing else live"), the same shape `/router` uses for its own
   *  optional dependency. */
  /** R-53: one outstanding helper login per config dir. Resolved by
   *  `POST /accounts/connect/helper-result`; a config dir with nothing waiting (a stale
   *  or duplicate post) is simply ignored, never an error -- the helper posts at most
   *  once per event, but a retry after a reconnect must stay harmless. */
  private readonly pendingHelperLogins = new Map<string, (outcome: { ok: boolean; link?: string; error?: string }) => void>();

  /** The `spawnFn` `ConsoleWrites` -> `realSpawnLogin` -> `exec.ts`'s `run()` receives
   *  under `FORGE_LOGIN_HELPER=1`. Only the `claude auth login` / `codex login` call is
   *  intercepted (matched on argv, the same way `realSpawnLogin` builds it); every other
   *  spawn passes straight through to the real `child_process.spawn`. */
  private loginHelperSpawnFn(): (command: string, args: string[], options: SpawnOptions) => ChildProcess {
    return (command, args, options) => {
      const isLogin = (command === 'claude' && args[0] === 'auth' && args[1] === 'login')
        || (args[0] === 'login' && command !== 'claude');
      if (!isLogin) {
        return realNodeSpawn(command, args, options);
      }
      const env = options.env;
      const configDir = env?.['CLAUDE_CONFIG_DIR'] ?? env?.['CODEX_HOME'] ?? '';
      const provider = command === 'claude' ? 'claude' : 'codex';
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new EventEmitter() as unknown as ChildProcess;
      (child as unknown as { stdout: PassThrough }).stdout = stdout;
      (child as unknown as { stderr: PassThrough }).stderr = stderr;
      this.publish({ event: 'accounts.connect-requested', accountId: configDir, configDir, provider });
      this.pendingHelperLogins.set(configDir, (outcome) => {
        if (outcome.link) stdout.write(`${outcome.link}\n`);
        stdout.end();
        stderr.end();
        child.emit('exit', outcome.ok ? 0 : 1, null);
      });
      return child;
    };
  }

  /** R-53: `POST /accounts/connect/helper-result` -- the login helper's own progress
   *  post, resolving whichever `claude auth login` call `loginHelperSpawnFn` is holding
   *  open for that config dir. */
  private loginHelperResult(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ configDir?: string; ok?: boolean; link?: string; error?: string }>(request, response, (parsed) => {
      if (!parsed || !parsed.configDir || typeof parsed.ok !== 'boolean') {
        json(response, 400, { error: 'a helper result needs a configDir and ok' });
        return;
      }
      const resolve = this.pendingHelperLogins.get(parsed.configDir);
      this.pendingHelperLogins.delete(parsed.configDir);
      resolve?.({ ok: parsed.ok, ...(parsed.link ? { link: parsed.link } : {}), ...(parsed.error ? { error: parsed.error } : {}) });
      json(response, 200, { ok: true, delivered: Boolean(resolve) });
    });
  }

  private codexAsk(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    const advisor = this.codexAdvisorDep;
    if (!advisor) {
      json(response, 501, { error: 'the Codex advisor is enabled but this server has none wired' });
      return;
    }
    this.readJson<{ prompt?: string; cwd?: string; label?: string; model?: string }>(request, response, (parsed) => {
      void (async () => {
        if (!parsed || !parsed.prompt || !parsed.cwd || !parsed.label) {
          json(response, 400, { error: 'asking Codex needs a prompt, a cwd and a label' });
          return;
        }
        const outcome = await advisor.ask({
          prompt: parsed.prompt!, cwd: parsed.cwd!, label: parsed.label!,
          ...(parsed.model ? { model: parsed.model } : {}),
        });
        json(response, 200, outcome);
      })();
    });
  }

  /** R-55: `GET /codex/:id`, wrapping the advisor's own `status`. */
  private codexStatusRoute(request: IncomingMessage, response: ServerResponse, id: string): void {
    if (!this.authorized(request, response)) return;
    const advisor = this.codexAdvisorDep;
    if (!advisor) {
      json(response, 501, { error: 'the Codex advisor is enabled but this server has none wired' });
      return;
    }
    void advisor.status(id).then((status) => json(response, 200, status));
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
        const outcome = await this.consoleWrites.confirmGate(parsed as Record<string, unknown> | null, 'console',
          'stops every running lane with a handoff request and engages the kill switch.',
          async () => {
            const { stopped, stale } = await new Fleet(
              this.lanes, this.registry, this.journalPath, this.killSwitchFile,
            ).stopAll(reason);
            for (const row of stopped) {
              this.publish({ event: 'run.parked', run: row.slug, actor: 'console', reached: row.reached });
            }
            const names = stopped.map((row) => row.slug);
            const message = `stopped ${names.length} lane${names.length === 1 ? '' : 's'}`;
            return { status: 200, body: { ok: true, jid: null, message, undoable: false, stopped: names, stale } };
          });
        json(response, outcome.status, outcome.body);
      })();
    });
  }

  /**
   * `POST /send`: queues a message into a run's own inbox, the same `RunInbox.send` that
   * `forge send RUN TEXT` calls. Delivered by the run's next tool call, per `runinbox.ts`.
   *
   * W1: refuses outright when nothing is listening -- no record on the board at all, or
   * a record with `heart: false` -- rather than writing a file nobody will ever read and
   * answering 200 as if it had. `assertRunListening` is the one check both this route
   * and the Conductor agent's `send_to_run` tool call, so a message routed through the
   * agent gets the same refusal a typed `/send` does.
   */
  private send(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ run?: string; text?: string }>(request, response, (parsed) => {
      if (!parsed || !parsed.run || !parsed.text) {
        json(response, 400, { error: 'a send needs a run and text' });
        return;
      }
      const verdict = assertRunListening(parsed.run, () => this.consoleReads.lanesResponse(true, true));
      if (!verdict.listening) {
        json(response, 409, { error: verdict.reason });
        return;
      }
      new RunInbox(parsed.run).send(parsed.text, 'console');
      json(response, 200, { ok: true });
    });
  }

  /**
   * `POST /amend`: `{ run, text }` corrects a running item mid-flight, per C.1. The text
   * lands in the brief file twice -- once as a dated `## Amendment` section a future
   * reader can see was added after the fact, and once folded into the same `##
   * Definition of Done` heading `conformance-drift.ts` re-reads every drift tick, so a
   * correction actually changes what "on task" means rather than sitting unread beside
   * it -- and once more through the run's own inbox, the same delivery `/send` uses, so
   * the current turn hears about it without waiting on the next drift check.
   */
  private amend(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ run?: string; text?: string }>(request, response, (parsed) => {
      if (!parsed || !parsed.run || !parsed.text) {
        json(response, 400, { error: 'an amendment needs a run and text' });
        return;
      }
      const outcome = amendRunBrief(parsed.run, parsed.text, this.amendDeps());
      json(response, outcome.status, outcome.body);
    });
  }

  /** The one amend implementation (`amend.ts#amendRunBrief`) this route and the
   *  Conductor agent's `amend_run` tool share. */
  private amendDeps(): AmendDeps {
    return { registry: this.registry, journalPath: this.journalPath, publish: (event) => this.publish(event) };
  }

  /**
   * `POST /clear`: `{ lane }` hands one breaker-blocked lane back the way `forge clear
   * LANE` does; `{ all: true }` clears the kill switch the way `forge clear --all` does.
   */
  private clearLane(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ lane?: string; all?: boolean; inboxKey?: string; confirm?: string }>(request, response, (parsed) => {
      if (parsed?.inboxKey) {
        void this.clearAsk(parsed, response);
        return;
      }
      if (parsed?.all === true) {
        clearKillSwitch(this.killSwitchFile);
        json(response, 200, { ok: true });
        return;
      }
      if (!parsed || !parsed.lane) {
        json(response, 400, { error: 'a clear needs a lane, { all: true } or { inboxKey }' });
        return;
      }
      new Breaker(this.lanes).clear(parsed.lane);
      json(response, 200, { ok: true });
    });
  }

  /**
   * `POST /clear { inboxKey }` (F3): retires one stale ask from the console's own
   * Dismiss button. The client's say-so is not proof: staleness is checked again here,
   * against the registry as it is right now, before anything is moved. Dismissing loses
   * the question for good, so it runs behind the confirm gate.
   */
  private async clearAsk(parsed: { inboxKey?: string; confirm?: string }, response: ServerResponse): Promise<void> {
    const key = parsed.inboxKey as string;
    const outcome = await this.consoleWrites.confirmGate(parsed as Record<string, unknown>, 'console',
      `dismisses the question ${key}: the ask leaves the inbox and nothing answers it.`,
      async () => {
        const entry = this.inbox.entry(key);
        if (!entry) return { status: 404, body: { error: `nothing asked ${key}` } };
        if (!isAskStale(entry, (run) => Boolean(this.registry.get(run)))) {
          return { status: 400, body: { error: `${key} still has a live run; it is not stale` } };
        }
        this.inbox.retire(key);
        const retired = appendOnce(this.journalPath, {
          event: 'inbox.retired', actor: 'console', key, runs: entry.runs,
        });
        // The console reads success off a non-null `jid`, so the row's own id goes back.
        return { status: 200, body: { ok: true, jid: retired.id, message: `dismissed ${key}`, undoable: false } };
      });
    json(response, outcome.status, outcome.body);
  }

  /**
   * `POST /run/:id/retire` and `POST /run/:id/unretire` (H1.7): moves one lane off, or
   * back onto, the board's default view. Retiring an ineligible lane (still running, an
   * open unmerged PR, a live process behind it) is refused outright rather than quietly
   * hiding something unresolved; unretiring is never refused, since undoing a retire
   * can never itself lose anything.
   */
  private retireOne(request: IncomingMessage, response: ServerResponse, id: string, retiring: boolean): void {
    if (!this.authorized(request, response)) return;
    // Unretiring puts a lane back and is undone by retiring it again, so it runs
    // straight through; retiring takes the lane off the default board and goes behind
    // the same server-issued confirm as every other irreversible route.
    if (!retiring) {
      const outcome = retireLane(id, false, this.retireLaneDeps());
      json(response, outcome.status, outcome.body);
      return;
    }
    this.readJson<{ confirm?: string }>(request, response, (parsed) => {
      void (async () => {
        const outcome = await this.consoleWrites.confirmGate(parsed as Record<string, unknown> | null, 'console',
          `retires ${id}: the lane leaves the board's default view.`,
          async () => retireLane(id, true, this.retireLaneDeps()));
        json(response, outcome.status, outcome.body);
      })();
    });
  }

  /** The one retire implementation (`retire.ts#retireLane`) this route, the rail's
   *  typed `remove <lane>` and the Conductor agent's `retire` tool all share. */
  private retireLaneDeps(): RetireLaneDeps {
    return {
      forgeHomeDir: this.forgeHomeDir, journalPath: this.journalPath,
      lanesAll: () => this.consoleReads.lanesResponse(true, true).lanes,
    };
  }

  /**
   * `POST /retire-finished` (H1.7): retires every lane that is done, merged, killed, or
   * a finished probe, with no open unmerged PR and no live process, in one call -- the
   * bulk equivalent of clicking Retire on each one by hand.
   */
  private retireFinishedRoute(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ confirm?: string }>(request, response, (parsed) => {
      void (async () => {
        const preview = retirePreview(retiredPath(this.forgeHomeDir), this.consoleReads.lanesResponse(true, true).lanes);
        const titles = preview.map((item) => item.title ?? item.id).join(', ') || 'nothing';
        const outcome = await this.consoleWrites.confirmGate(parsed as Record<string, unknown> | null, 'console',
          `retires ${preview.length} finished lane${preview.length === 1 ? '' : 's'}: ${titles}`,
          async () => {
            const lanes = this.consoleReads.lanesResponse(true, true).lanes;
            const retired = retireFinished(retiredPath(this.forgeHomeDir), lanes, Date.now());
            for (const id of retired) {
              appendOnce(this.journalPath, { event: 'lane.retired', run: id, actor: 'console', retired: true });
            }
            return { status: 200, body: { ok: true, jid: null, message: `retired ${retired.length} lane(s)`, undoable: false, retired } };
          });
        json(response, outcome.status, outcome.body);
      })();
    });
  }

  /** `GET /retire-finished` (H1.7): a read-only preview of what a bulk retire would
   *  touch -- the same eligibility rule as the POST, with nothing actually retired. */
  private retireFinishedPreviewRoute(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    const lanes = this.consoleReads.lanesResponse(true, true).lanes;
    const items = retirePreview(retiredPath(this.forgeHomeDir), lanes);
    json(response, 200, { items });
  }

  /** `GET /merge-ready` (H1.8): every lane whose PR is ready by the queue's own rules,
   *  and every lane with a PR that is not, each with the reason in words -- the same
   *  `mergeable` field `GET /lanes` already carries per lane, just filtered down to the
   *  ones that actually have a PR to report on. */
  private mergeReadyGet(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    void (async () => {
      json(response, 200, await this.consoleReads.mergeReadyReport());
    })();
  }

  /**
   * `POST /merge-ready` (H1.8): merges every ready lane, one at a time, through the
   * same path the queue's own Merge click already uses (`mergeItem`) -- never a repo
   * outside `FORGE_QUEUE_MERGE_REPOS`, since `mergeItem` itself refuses that. A chain
   * lane (no queue item behind it) is reported honestly as unmerged here rather than
   * guessed at: this environment's `chainGate` merge path is not wired to this route.
   */
  private mergeReadyPost(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ confirm?: string }>(request, response, (parsed) => {
      void (async () => {
        const { ready } = mergeReadyReportFrom(this.consoleReads.lanesResponse(true).lanes);
        const names = ready.map((lane) => lane.title ?? lane.id).join(', ') || 'nothing';
        const outcome = await this.consoleWrites.confirmGate(parsed as Record<string, unknown> | null, 'console',
          `merges ${ready.length} ready lane${ready.length === 1 ? '' : 's'}: ${names}`,
          async () => this.mergeReadyRun());
        json(response, outcome.status, outcome.body);
      })();
    });
  }

  /** The merge itself, once confirmed: one outcome row per lane a merge was attempted on. */
  private async mergeReadyRun(): Promise<{ status: number; body: unknown }> {
    {
      const { ready } = mergeReadyReportFrom(this.consoleReads.lanesResponse(true).lanes);
      const outcomes: Array<{ id: string; ok: boolean; message: string }> = [];
      for (const lane of ready) {
        const item = this.queueStoreForMerge.all().find((row) => row.runKey === lane.id);
        if (!item) {
          outcomes.push({ id: lane.id, ok: false, message: 'no queue item behind this lane; chain-lane merges are not wired to this route' });
          continue;
        }
        if (!this.queueMergeDepsOpt) {
          outcomes.push({ id: lane.id, ok: false, message: 'no merge wiring is configured for this environment' });
          continue;
        }
        const outcome = await mergeItem(item, this.queueMergeDepsOpt);
        appendOnce(this.journalPath, {
          event: 'merge-ready.merged', actor: 'console', itemId: item.id, run: lane.id, ok: outcome.ok, message: outcome.message,
        });
        outcomes.push({ id: lane.id, ok: outcome.ok, message: outcome.message });
      }
      const merged = outcomes.filter((row) => row.ok).length;
      const failed = outcomes.length - merged;
      const message = `merged ${merged} lane${merged === 1 ? '' : 's'}${failed > 0 ? `, ${failed} could not merge` : ''}`;
      return { status: 200, body: { ok: outcomes.every((row) => row.ok), jid: null, message, undoable: false, outcomes } };
    }
  }

  /**
   * `POST /router`: a message typed into the console's rail thread. Behind the same
   * token and Origin check as every other write. Off by default at the policy layer
   * (`routerEnabled()`) -- while it is off this never calls `classify`/`act`, so a
   * message posted here costs nothing and reaches no model, which is the mechanism
   * behind "live routing stays off until Aaron turns `router.enabled` on."
   */
  private routeMessage(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request, response)) return;
    this.readJson<{ text?: string }>(request, response, (parsed) => {
      void (async () => {
        if (!parsed || !parsed.text) {
          json(response, 400, { error: 'a router message needs text' });
          return;
        }
        if (!routerEnabled()) {
          json(response, 200, { routed: false, reason: 'router off' });
          return;
        }
        if (!this.reasoner) {
          json(response, 501, { error: 'the router is enabled but this server has no reasoner wired' });
          return;
        }
        const outcome = await routeMessage(this.reasoner, parsed.text, {
          inbox: this.inbox,
          journal: { append: (event) => appendOnce(this.journalPath, event) },
          stateSummary: () => JSON.stringify(this.state()),
          openAsks: () => this.inbox.open(),
        });
        json(response, 200, { routed: true, outcome });
      })();
    });
  }

  /**
   * `GET /run/:id`: the ticket sheet's own read, behind the token like every other write
   * on this server -- a packet, a provenance chain and a run's journal state are not
   * public the way `/state`'s aggregate counts are, since a packet can carry whatever a
   * worker wrote about the goal it was on.
   *
   * A run this server has never heard of, or one with no packet on disk yet, is not an
   * error: `packet: null` and an empty provenance chain are the honest answer for a run
   * that has not handed off, and the ticket sheet renders "not available" rather than a
   * 404 for either. `plan`, `prUrl`, `council` and `comments` are not wired yet (no code
   * anywhere in this repository writes them for a run today); they are named explicitly
   * as `null` rather than omitted, so the sheet can say "not wired" instead of leaving a
   * silently missing field indistinguishable from one that failed to load.
   */
  private runDetail(request: IncomingMessage, response: ServerResponse, id: string): void {
    if (!this.authorized(request, response)) return;
    if (!id) {
      json(response, 400, { error: 'a run id is required' });
      return;
    }
    const fleet = this.journalCache.read(this.journalPath);
    const run = fleet.runs[id];
    const packetFile = join(this.packetsDirPath, `${id}.md`);
    const packet = existsSync(packetFile) ? readFileSync(packetFile, 'utf8') : null;
    json(response, 200, {
      run: id,
      packet,
      plan: null,
      prUrl: null,
      council: null,
      comments: null,
      provenance: { predecessor: run?.predecessor ?? null, successor: run?.successor ?? null },
      state: run ?? null,
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
  // Item 3, 2026-09-05: a three-minute-old probe that had spent $3.06 was shown as
  // $61.11/h -- the old five-minute-hour fraction (1/120, i.e. 30 seconds) let anything
  // past its first half-minute get divided by a sliver of an hour and reported as a rate
  // with no relationship to what the run would cost across a real one. Five minutes
  // (1/12 of an hour) is the shortest span this treats as long enough to extrapolate from.
  if (hours < 1 / 12) return 0;
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
