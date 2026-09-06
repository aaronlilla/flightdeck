/**
 * The console's read routes, wired to the real filesystem.
 *
 * One class, one `handle()` call, mirroring the shape `server.ts#route()` already uses
 * for its own dispatch. Every module this delegates to (`lanes.ts`, `thread.ts`,
 * `journal-route.ts`, `pr.ts`, `sandbox.ts`, `caps-read.ts`, `proposals.ts`) is pure
 * given its inputs; this class is the only place that reads a real file or shells out.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { run as execRun } from '../exec.js';
import { Inbox } from '../inbox.js';
import { JournalCache } from '../journal.js';
import { forgeHome, inboxDir, lanesDir, registryDir, runDir, runsDir } from '../paths.js';
import { foldChainState, type ChainPacketState } from '../chain.js';
import { classFor, classNames, governorBudget, policyPath } from '../policy.js';
import { Registry } from '../registry.js';
import type { StuckSignal } from '../liveness.js';
import { Lanes, type LaneRecord } from '../supervisor.js';
import { RunInbox } from '../runinbox.js';
import type {
  Caps, JournalResponse, LanesResponse, ProposalsResponse, RunPrResponse, RunSandboxResponse,
  RunThreadResponse, ThreadResponse,
} from '../../shared/console-model.js';
import { capsOverridesPath, computeCaps, readCapsOverrides } from './caps-read.js';
import { ensureHardUsd } from './caps-write.js';
import { actionsLedgerPath, computeJournal, readActionsLedger } from './journal-route.js';
import { computeLanes, spentTodayUsd, windowLanes, type LanesInput } from './lanes.js';
import { computeRunPr, prCachePath, readPrCache, writePrCache, type GhLookupFn, type GhPrLookup } from './pr.js';
import { computeProposals, readRules, rulesPath } from './proposals.js';
import { computeSandbox, newestLogFile, tailLog } from './sandbox.js';
import { computeRunThread, computeThread, readThread, threadPath } from './thread.js';

export interface ConsoleReadsOptions {
  lanes?: Lanes;
  registry?: Registry;
  inbox?: Inbox;
  journalPath?: string;
  journalCache?: JournalCache;
  forgeHomeDir?: string;
  /** Overrides `gh pr list`. A specimen never shells out. */
  ghLookup?: GhLookupFn;
  /** Overrides the fleet-process probe `stuck` reads for `blockedBy` context. Defaults
   *  to reporting nothing stuck, the same conservative default `ForgeServer` uses. */
  stuck?: () => StuckSignal[];
  /** Overrides where `GET /caps` reads the Governor's budget from, and where
   *  `ensureHardUsd` writes a missing `hardUsd` back to. Defaults to `policyPath()`,
   *  which (unlike every other Forge path) does not follow `FORGE_HOME` -- a specimen
   *  always sets this, or `GET /caps` writes into this repo's own tracked
   *  `model-policy.json` the moment `hardUsd` is absent from it. */
  modelPolicyPath?: string;
}

function usdPerHour(lane: LaneRecord, now: number): number {
  if (!lane.started || !lane.cost_usd) return 0;
  const hours = (now - lane.started) / 3_600_000;
  if (hours < 1 / 12) return 0;
  return Number((lane.cost_usd / hours).toFixed(4));
}

function defaultGhLookup(): GhLookupFn {
  return async (branch: string): Promise<GhPrLookup | undefined> => {
    const result = await execRun({
      argv: ['gh', 'pr', 'list', '--head', branch, '--json', 'number,url,isDraft,additions,deletions,changedFiles'],
      cwd: process.cwd(), owner: 'console-pr', cls: 'script',
    });
    if (!result.ok) return undefined;
    try {
      const rows = JSON.parse(result.tail) as GhPrLookup[];
      return rows[0];
    } catch {
      return undefined;
    }
  };
}

/** The runs `GET /run/:id` matches, and everything under it -- `/run/:id/thread`,
 *  `/run/:id/pr`, `/run/:id/sandbox`. */
const RUN_SUBROUTE = /^\/run\/([^/]+)\/(thread|pr|sandbox)$/;

export class ConsoleReads {
  private readonly lanes: Lanes;

  private readonly registry: Registry;

  private readonly inbox: Inbox;

  private readonly journalPath: string;

  private readonly journalCache: JournalCache;

  private readonly forgeHomeDir: string;

  private readonly ghLookup: GhLookupFn;

  private readonly stuckFn: () => StuckSignal[];

  private readonly modelPolicyPath: string;

  constructor(options: ConsoleReadsOptions = {}) {
    this.forgeHomeDir = options.forgeHomeDir ?? forgeHome();
    this.lanes = options.lanes ?? new Lanes(lanesDir());
    this.registry = options.registry ?? new Registry(registryDir());
    this.inbox = options.inbox ?? new Inbox(inboxDir());
    this.journalPath = options.journalPath ?? join(this.forgeHomeDir, 'fleet.jsonl');
    this.journalCache = options.journalCache ?? new JournalCache();
    this.ghLookup = options.ghLookup ?? defaultGhLookup();
    this.stuckFn = options.stuck ?? (() => []);
    this.modelPolicyPath = options.modelPolicyPath ?? policyPath();
  }

  private chain(): Map<string, ChainPacketState> {
    return foldChainState(this.journalCache.read(this.journalPath).events);
  }

  /** Whether `path`/`method` names one of this class's own routes, with no side effect --
   *  what `server.ts#route()` checks before it runs its own `authorized()` gate, since
   *  every one of these reads needs the token the same way every route but `/state`
   *  does, and this class has no access to the server's own token check. */
  static matches(path: string, method: string | undefined): boolean {
    if (method !== 'GET') return false;
    return path === '/lanes' || path === '/thread' || path === '/journal' || path === '/caps'
      || path === '/proposals' || RUN_SUBROUTE.test(path);
  }

  /** True when a request matched a route this class owns and the response has already
   *  been sent -- the same return convention `server.ts#route()` already uses for its
   *  own dispatch, so the delegation line reads the same way for both console halves.
   *  Callers must run their own authorization check first (see `matches`): this method
   *  assumes the caller has already refused an unauthorized request. */
  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== 'GET') return false;

    if (path === '/lanes') {
      const url = new URL(request.url ?? '/', 'http://localhost');
      json(response, 200, this.lanesResponse(url.searchParams.get('all') === '1'));
      return true;
    }
    if (path === '/thread') {
      json(response, 200, this.threadResponse());
      return true;
    }
    if (path === '/journal') {
      const url = new URL(request.url ?? '/', 'http://localhost');
      json(response, 200, this.journalResponse({
        since: numOrUndefined(url.searchParams.get('since')),
        run: url.searchParams.get('run') ?? undefined,
        limit: numOrUndefined(url.searchParams.get('limit')),
      }));
      return true;
    }
    if (path === '/caps') {
      json(response, 200, this.capsResponse());
      return true;
    }
    if (path === '/proposals') {
      json(response, 200, this.proposalsResponse());
      return true;
    }

    const runMatch = RUN_SUBROUTE.exec(path);
    if (runMatch) {
      const id = runMatch[1] ?? '';
      const sub = runMatch[2] as 'thread' | 'pr' | 'sandbox';
      const run = decodeURIComponent(id);
      if (sub === 'thread') {
        json(response, 200, this.runThreadResponse(run));
        return true;
      }
      if (sub === 'pr') {
        json(response, 200, await this.runPrResponse(run));
        return true;
      }
      json(response, 200, this.runSandboxResponse(run));
      return true;
    }

    return false;
  }

  /** Public so `command.ts`'s `status` intent can answer from the same lane counts and
   *  spend the board itself shows, rather than a figure of its own. `all` bypasses the
   *  24-hour finished-lane window (`GET /lanes?all=1`); `status` calls this with the
   *  window on, the same default the board itself renders. */
  lanesResponse(all = false): LanesResponse {
    const now = Date.now();
    const fleet = this.journalCache.read(this.journalPath);
    const chain = this.chain();
    const prCache = readPrCache(prCachePath(this.forgeHomeDir));
    const budget = governorBudget(this.modelPolicyPath);
    const input: LanesInput = {
      laneRecords: this.lanes.all(),
      fleet,
      chain,
      registryGet: (run) => this.registry.get(run),
      openAsks: this.inbox.open(),
      stuck: this.stuckFn(),
      classFor: (name) => {
        try {
          return classFor(name, this.modelPolicyPath);
        } catch {
          return undefined;
        }
      },
      usdPerRun: budget.usdPerRun,
      capOverrides: readCapsOverrides(capsOverridesPath(this.forgeHomeDir)).perRun ?? {},
      prFor: (run) => prCache[run]?.pr ?? null,
      usdPerHour: (lane) => usdPerHour(lane, now),
    };
    return windowLanes(computeLanes(input, now), now, all);
  }

  private threadResponse(): ThreadResponse {
    const now = Date.now();
    const persisted = readThread(threadPath(this.forgeHomeDir));
    const fleet = this.journalCache.read(this.journalPath);
    return computeThread(persisted, fleet.events, now);
  }

  private journalResponse(query: { since?: number; run?: string; limit?: number }): JournalResponse {
    const fleet = this.journalCache.read(this.journalPath);
    const ledger = readActionsLedger(actionsLedgerPath(this.forgeHomeDir));
    return computeJournal(fleet.events, ledger, query);
  }

  private capsResponse(): Caps {
    const now = Date.now();
    const fleet = this.journalCache.read(this.journalPath);
    const budget = governorBudget(this.modelPolicyPath);
    const overrides = readCapsOverrides(capsOverridesPath(this.forgeHomeDir));
    const implementClassName = classNames(this.modelPolicyPath).includes('implement')
      ? 'implement' : (classNames(this.modelPolicyPath)[0] ?? 'implement');
    // A policy file with no `governor` block reads back as `{ dailyUsd: Infinity,
    // usdPerRun: {} }` (policy.ts's own `governorBudget` default) -- the only way to
    // tell that apart from a real, deliberately-unbounded budget is that a configured
    // one always sets at least one of the two.
    const governorConfigured = Number.isFinite(budget.dailyUsd) || Object.keys(budget.usdPerRun).length > 0;
    // `ensureHardUsd` writes 5x dailyUsd into the policy file's own governor block the
    // first time it finds no hardUsd there, so the org hard limit (FD-7) the caps sheet
    // shows is a real, stable number in model-policy.json rather than a fresh
    // computation nobody editing that file by hand would ever see.
    const hardUsd = governorConfigured ? ensureHardUsd(this.modelPolicyPath) : Number.POSITIVE_INFINITY;
    return computeCaps({
      governor: { ...budget, hardUsd } as ReturnType<typeof governorBudget> & { hardUsd?: number },
      implementClassName,
      overrides,
      spentTodayUsd: spentTodayUsd(fleet.runs, now),
      governorConfigured,
    });
  }

  private proposalsResponse(): ProposalsResponse {
    const now = Date.now();
    const fleet = this.journalCache.read(this.journalPath);
    const costUsdByRun = Object.fromEntries(Object.entries(fleet.runs).map(([run, state]) => [run, state.costUsd]));
    const existingRules = readRules(rulesPath(this.forgeHomeDir));
    return computeProposals(fleet.events, now, costUsdByRun, existingRules);
  }

  private runThreadResponse(run: string): RunThreadResponse {
    const fleet = this.journalCache.read(this.journalPath);
    return computeRunThread(run, fleet.events, new RunInbox(run).all());
  }

  private async runPrResponse(run: string): Promise<RunPrResponse> {
    const now = Date.now();
    const cachePath = prCachePath(this.forgeHomeDir);
    const cache = readPrCache(cachePath);
    const { pr, cache: nextCache } = await computeRunPr(run, this.chain(), cache, now, this.ghLookup);
    if (nextCache !== cache) writePrCache(cachePath, nextCache);
    return { pr };
  }

  private runSandboxResponse(run: string): RunSandboxResponse {
    const sandbox = computeSandbox(run, this.chain(), this.registry.get(run));
    const logFile = existsSync(runsDir()) ? newestLogFile(runDir(run)) : undefined;
    return { sandbox, log: tailLog(logFile) };
  }
}

function numOrUndefined(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}
