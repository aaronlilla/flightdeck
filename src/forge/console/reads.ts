/**
 * The console's read routes, wired to the real filesystem.
 *
 * One class, one `handle()` call, mirroring the shape `server.ts#route()` already uses
 * for its own dispatch. Every module this delegates to (`lanes.ts`, `thread.ts`,
 * `journal-route.ts`, `pr.ts`, `sandbox.ts`, `caps-read.ts`, `proposals.ts`) is pure
 * given its inputs; this class is the only place that reads a real file or shells out.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { run as execRun } from '../exec.js';
import { Inbox } from '../inbox.js';
import { JournalCache } from '../journal.js';
import { readdirSync } from 'node:fs';
import { forgeHome, inboxDir, lanesDir, queuePath as defaultQueuePath, registryDir, runDir, runsDir } from '../paths.js';
import { foldChainState, type ChainPacketState } from '../chain.js';
import { classFor, classNames, governorBudget, policyPath } from '../policy.js';
import { QueueStore } from '../intake/queueStore.js';
import { Registry } from '../registry.js';
import type { StuckSignal } from '../liveness.js';
import { Lanes, type LaneRecord } from '../supervisor.js';
import { RunInbox } from '../runinbox.js';
import type {
  Caps, JournalResponse, Lane, LanePr, LaneStory, LanesResponse, LaneSummary, ProposalsResponse, QueueItem,
  RunCostResponse, RunJournalResponse, RunPrResponse, RunSandboxResponse, RunThreadResponse, ThreadResponse,
} from '../../shared/console-model.js';
import { capsOverridesPath, computeCaps, readCapsOverrides } from './caps-read.js';
import { ensureHardTokens } from './caps-write.js';
import { computeCostSteps, findCapEnforcementFailure } from './cost-steps.js';
import { actionsLedgerPath, computeJournal, readActionsLedger } from './journal-route.js';
import { computeJournalNarrative } from './journal-narrative.js';
import { readAttestation } from '../council/attest.js';
import { queueMergeAllowed } from '../queue-wire.js';
import {
  chainLinks, computeLanes, labelFor as laneLabelFor, mergeableFor, mergeReadyReportFrom, tokensToday, titleFor,
  titleFromHeading, windowLanes, type LanesInput,
} from './lanes.js';
import { computeLaneStory, type GitCommit } from './story.js';
import { readRetired, retiredPath } from './retire.js';
import { plainForQueueItem, plainStatus, prMergedSentence, type QueueVerdict } from './plain.js';
import { computeYou } from './laneGlance.js';
import { readAttestationAtPath } from '../council/attest.js';
import {
  computeBranchPr, computeQueuePr, computeRunPr, PR_CACHE_TTL_MS, prCachePath, readPrCache, writePrCache,
  type AttestationReaderFn, type Cache, type GhBranchLookupFn, type GhBranchPr, type GhDetailLookupFn, type GhLookupFn,
  type GhPrDetail, type GhPrLookup,
} from './pr.js';
import { computeProposals, readRules, rulesPath } from './proposals.js';
import { computeSandbox, newestLogFile, packetForRun, tailLogWithSeverity } from './sandbox.js';
import { computeRunThread, computeThread, readThread, threadPath } from './thread.js';
import { computeLaneSummary, computeReadiness, type PrFacts } from './summary.js';
import type { MergeReadyReport } from '../../shared/console-model.js';
import { gitDrift, type DriftFacts, type DriftFn } from './drift.js';
import { readChainEnv } from '../chain-env.js';
import { shortenShas, stripMachineIds } from '../../shared/humanize.js';

export interface ConsoleReadsOptions {
  lanes?: Lanes;
  registry?: Registry;
  inbox?: Inbox;
  journalPath?: string;
  journalCache?: JournalCache;
  forgeHomeDir?: string;
  /** Overrides `gh pr list`. A specimen never shells out. */
  ghLookup?: GhLookupFn;
  /** H1.3: overrides `gh pr view`'s own checks/merged/title read. A specimen never
   *  shells out. */
  ghDetailLookup?: GhDetailLookupFn;
  /** Item 11: overrides `gh pr list --repo <repo> --head <branch> --state all`, the
   *  by-branch PR discovery for a lane whose queue item carries no PR at all. A
   *  specimen never shells out. */
  ghBranchLookup?: GhBranchLookupFn;
  /** H1.3: overrides the attestation-on-disk read for a PR's own council verdict. A
   *  specimen only. */
  attestationReader?: AttestationReaderFn;
  /** Overrides the fleet-process probe `stuck` reads for `blockedBy` context. Defaults
   *  to reporting nothing stuck, the same conservative default `ForgeServer` uses. */
  stuck?: () => StuckSignal[];
  /** Overrides where `GET /caps` reads the Governor's budget from, and where
   *  `ensureHardTokens` writes a missing `hardTokens` back to. Defaults to `policyPath()`,
   *  which (unlike every other Forge path) does not follow `FORGE_HOME` -- a specimen
   *  always sets this, or `GET /caps` writes into this repo's own tracked
   *  `model-policy.json` the moment `hardTokens` is absent from it. */
  modelPolicyPath?: string;
  /** Overrides where `GET /lanes` reads the intake queue's own log from, to join a
   *  queue-sourced lane to its item (H1.1: the item's brief and PR carry the title and
   *  source link a bare run id cannot). Defaults to `queuePath()`, which follows
   *  `FORGE_HOME`. A specimen only. */
  queueStore?: QueueStore;
  /** Overrides `FORGE_JIRA_SITE` for `GET /lanes`'s own title/sourceUrl fields. A
   *  specimen only -- production always reads the real environment. */
  jiraSite?: string | null;
  /** H1.4: overrides the queue's own merge allow-list (`FORGE_QUEUE_MERGE_REPOS`) for
   *  `GET /lanes`'s `mergeable` field. A specimen only -- production always reads the
   *  real environment. */
  mergeAllowed?: (repo: string) => boolean;
  /** H1.6: overrides `git log` of a lane's own worktree for `GET /run/:id/story`'s
   *  commit entries. A specimen never shells out. */
  gitLog?: (worktreePath: string, range: GitLogRange) => Promise<GitCommit[]>;
  /** 2026-09-07: overrides the ticket sheet summary's own drift facts (`GET`/`POST
   *  /run/:id/{summary,recheck}`). A specimen never shells out. Defaults to real git
   *  against `FORGE_REPO_CHECKOUTS`. */
  driftFn?: DriftFn;
}

/** The lane's own burn rate in tokens/hour, off the journal's real cumulative total for
 *  its run -- never `lane.cost_usd` (the registry's dollar-denominated field, shared
 *  with the legacy `/state` server this stream does not touch). A lane the journal has
 *  no run state for yet reads 0 rather than a conversion this file cannot honestly make. */
function tokensPerHour(lane: LaneRecord, tokensUsed: number, now: number): number {
  if (!lane.started || !tokensUsed) return 0;
  const hours = (now - lane.started) / 3_600_000;
  if (hours < 1 / 12) return 0;
  return Number((tokensUsed / hours).toFixed(4));
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

interface RawStatusCheckLike {
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
}

function conclusionOf(rollup: RawStatusCheckLike[] | undefined): 'success' | 'failure' | 'pending' {
  if (!rollup || rollup.length === 0) return 'pending';
  const states = rollup.map((entry) => (entry.conclusion ?? entry.status ?? entry.state ?? '').toUpperCase());
  if (states.some((state) => state === '' || state === 'PENDING' || state === 'IN_PROGRESS' || state === 'QUEUED')) {
    return 'pending';
  }
  if (states.every((state) => state === 'SUCCESS')) return 'success';
  return 'failure';
}

/** H1.3: `gh pr view --json isDraft,mergedAt,statusCheckRollup,title,headRefOid` --
 *  the same checks-rollup reading `council/gh.ts#conclusionOf` uses, duplicated rather
 *  than imported since that module belongs to the council's own gate, not the console. */
function defaultGhDetailLookup(): GhDetailLookupFn {
  return async (repo: string, pr: number): Promise<GhPrDetail | undefined> => {
    const result = await execRun({
      argv: [
        'gh', 'pr', 'view', String(pr), '--repo', repo, '--json',
        'isDraft,mergedAt,statusCheckRollup,title,headRefOid,body',
      ],
      cwd: process.cwd(), owner: 'console-pr-detail', cls: 'script', fullOutput: true,
    });
    if (!result.ok) return undefined;
    try {
      const parsed = JSON.parse(result.full ?? result.tail) as {
        isDraft?: boolean; mergedAt?: string | null; statusCheckRollup?: RawStatusCheckLike[];
        title?: string; headRefOid?: string; body?: string | null;
      };
      if (!parsed.headRefOid) return undefined;
      return {
        headSha: parsed.headRefOid, isDraft: parsed.isDraft ?? false, merged: Boolean(parsed.mergedAt),
        title: parsed.title ?? '', checks: conclusionOf(parsed.statusCheckRollup), body: parsed.body ?? null,
        mergedAt: parsed.mergedAt ? Date.parse(parsed.mergedAt) : null,
      };
    } catch {
      return undefined;
    }
  };
}

/** The base a story's own commit range is read against: `queueItem.base` when the
 *  queue set one, else whichever of `origin/develop`, `origin/main`, `main` this
 *  worktree actually has, else `null` (no base resolved at all). */
export interface GitLogRange {
  base: string | null;
  since: number;
}

async function resolveMergeBaseRange(worktreePath: string, base: string): Promise<string[] | null> {
  const mergeBase = await execRun({
    argv: ['git', 'merge-base', base, 'HEAD'],
    cwd: worktreePath, owner: 'console-story-mergebase', cls: 'script',
  });
  if (!mergeBase.ok) return null;
  const sha = (mergeBase.full ?? mergeBase.tail).trim();
  return sha ? [`${sha}..HEAD`] : null;
}

const FALLBACK_BASE_CANDIDATES = ['origin/develop', 'origin/main', 'main'];

/** H1.6 / story scoping: `git log`, subjects only, oldest first, scoped to the range a
 *  story's commit entries should actually cover -- never the whole repository (2026-09-08
 *  finding: a self lane with no queue base listed the whole flightdeck history, 218
 *  commits back to 2026-08-10).
 *
 * `range.base` (`queueItem.base`) wins when set: `git log --reverse
 * <merge-base(base,HEAD)>..HEAD`. With no base set, this tries `origin/develop`, then
 * `origin/main`, then `main` in turn and uses the first that resolves. When neither the
 * given base nor any fallback resolves (no such ref, or the worktree is not a git repo
 * at all), this falls back to `git log --since=<range.since>` -- never the unranged
 * whole-history log the bug used to run. A worktree that no longer exists (a lane long
 * since cleaned up) reads as no commits rather than throwing. */
function defaultGitLog(): (worktreePath: string, range: GitLogRange) => Promise<GitCommit[]> {
  return async (worktreePath: string, range: GitLogRange): Promise<GitCommit[]> => {
    let scope: string[] | null = null;
    if (range.base) {
      scope = await resolveMergeBaseRange(worktreePath, range.base);
    } else {
      for (const candidate of FALLBACK_BASE_CANDIDATES) {
        const check = await execRun({
          argv: ['git', 'rev-parse', '--verify', candidate],
          cwd: worktreePath, owner: 'console-story-base-check', cls: 'script',
        });
        if (check.ok) {
          scope = await resolveMergeBaseRange(worktreePath, candidate);
          if (scope) break;
        }
      }
    }
    const rangeArgs = scope ?? [`--since=${new Date(range.since).toISOString()}`];
    const result = await execRun({
      argv: ['git', 'log', '--reverse', ...rangeArgs, '--format=%H%x09%ct%x09%s'],
      cwd: worktreePath, owner: 'console-story-gitlog', cls: 'script', fullOutput: true,
    });
    if (!result.ok) return [];
    const text = result.full ?? result.tail;
    return text.split('\n').filter(Boolean).map((line) => {
      const [sha, ctSeconds, ...rest] = line.split('\t');
      return { sha: sha ?? '', at: Number(ctSeconds ?? 0) * 1000, subject: rest.join('\t') };
    }).filter((commit) => commit.sha);
  };
}

/** Item 11: `gh pr list --repo <repo> --head <branch> --state all --json
 *  number,url,isDraft,mergedAt,title,headRefOid` -- `--state all` so an already-merged
 *  PR is found too, not only an open one. */
function defaultGhBranchLookup(): GhBranchLookupFn {
  return async (repo: string, branch: string): Promise<GhBranchPr | undefined> => {
    const result = await execRun({
      argv: [
        'gh', 'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json',
        'number,url,isDraft,mergedAt,title,headRefOid',
      ],
      cwd: process.cwd(), owner: 'console-pr-branch', cls: 'script', fullOutput: true,
    });
    if (!result.ok) return undefined;
    try {
      const rows = JSON.parse(result.full ?? result.tail) as GhBranchPr[];
      return rows[0];
    } catch {
      return undefined;
    }
  };
}

function defaultAttestationReader(): AttestationReaderFn {
  return (repo, pr, head) => {
    const attestation = readAttestation(repo, pr, head);
    return attestation ? { verdict: attestation.verdict } : undefined;
  };
}

/** The runs `GET /run/:id` matches, and everything under it -- `/run/:id/thread`,
 *  `/run/:id/pr`, `/run/:id/sandbox`, `/run/:id/cost`, `/run/:id/journal`. */
const RUN_SUBROUTE = /^\/run\/([^/]+)\/(thread|pr|sandbox|cost|journal|story|summary)$/;

export class ConsoleReads {
  private readonly lanes: Lanes;

  private readonly registry: Registry;

  private readonly inbox: Inbox;

  private readonly journalPath: string;

  private readonly journalCache: JournalCache;

  private readonly forgeHomeDir: string;

  private readonly ghLookup: GhLookupFn;

  private readonly ghDetailLookup: GhDetailLookupFn;

  private readonly ghBranchLookup: GhBranchLookupFn;

  private readonly attestationReader: AttestationReaderFn;

  private readonly stuckFn: () => StuckSignal[];

  private readonly modelPolicyPath: string;

  private readonly queueStore: QueueStore;

  private readonly jiraSite: string | null;

  private readonly mergeAllowedFn: (repo: string) => boolean;

  private readonly gitLogFn: (worktreePath: string, range: GitLogRange) => Promise<GitCommit[]>;

  private readonly driftFn: DriftFn;

  /** Item 7: run ids a background PR-detail refresh is already in flight for, so a
   *  lane polled again before the first `gh` read lands never queues a second one. */
  private readonly prRefreshInFlight = new Set<string>();

  /** Item 11: run ids a background by-branch PR discovery is already in flight for --
   *  the same in-flight guard `prRefreshInFlight` gives the detail refresh, kept
   *  separate since the two can legitimately run at once for different lanes. */
  private readonly branchPrDiscoveryInFlight = new Set<string>();

  /** Item 7: every background PR-detail refresh `GET /lanes` has kicked off so far,
   *  for `settlePrRefreshes()` (tests only) to wait on. Production never awaits this --
   *  a poll must never block on `gh`. */
  private pendingPrRefreshes: Promise<void>[] = [];

  /** Item 2: `ghDetailLookup(repo, pr)` reads, cached per (repo, pr) for `PR_CACHE_TTL_MS`
   *  -- the same window the board's own `pr-cache.json` uses. `GET /run/:id/summary`
   *  used to call this twice in one request (once through `runStoryResponse`, once for
   *  its own fresh read) and again on every re-open inside the same minute; that pair of
   *  calls, plus a `git fetch` for drift, is the live console's own 11-second sheet. An
   *  in-memory `Map` is enough: this cache only needs to survive one process's uptime,
   *  never a restart, unlike the on-disk `pr-cache.json` other routes share. */
  private readonly detailCache = new Map<string, { detail: GhPrDetail | undefined; at: number }>();

  /** Item 2: `driftFn(...)` reads, cached the same way and for the same window, keyed by
   *  repo, PR number and the head sha the drift check actually ran against. */
  private readonly driftCache = new Map<string, { drift: DriftFacts; at: number }>();

  private async cachedDetail(repo: string, pr: number): Promise<GhPrDetail | undefined> {
    const key = `${repo}#${pr}`;
    const now = Date.now();
    const cached = this.detailCache.get(key);
    if (cached && now - cached.at < PR_CACHE_TTL_MS) return cached.detail;
    const detail = await this.ghDetailLookup(repo, pr);
    this.detailCache.set(key, { detail, at: now });
    return detail;
  }

  private async cachedDrift(args: Parameters<DriftFn>[0]): Promise<DriftFacts> {
    const key = `${args.repo}#${args.pr}#${args.headSha ?? ''}#${args.attestationHead ?? ''}`;
    const now = Date.now();
    const cached = this.driftCache.get(key);
    if (cached && now - cached.at < PR_CACHE_TTL_MS) return cached.drift;
    const drift = await this.driftFn(args);
    this.driftCache.set(key, { drift, at: now });
    return drift;
  }

  constructor(options: ConsoleReadsOptions = {}) {
    this.forgeHomeDir = options.forgeHomeDir ?? forgeHome();
    this.lanes = options.lanes ?? new Lanes(lanesDir());
    this.registry = options.registry ?? new Registry(registryDir());
    this.inbox = options.inbox ?? new Inbox(inboxDir());
    this.journalPath = options.journalPath ?? join(this.forgeHomeDir, 'fleet.jsonl');
    this.journalCache = options.journalCache ?? new JournalCache();
    this.ghLookup = options.ghLookup ?? defaultGhLookup();
    this.ghDetailLookup = options.ghDetailLookup ?? defaultGhDetailLookup();
    this.ghBranchLookup = options.ghBranchLookup ?? defaultGhBranchLookup();
    this.attestationReader = options.attestationReader ?? defaultAttestationReader();
    this.stuckFn = options.stuck ?? (() => []);
    this.modelPolicyPath = options.modelPolicyPath ?? policyPath();
    this.queueStore = options.queueStore ?? new QueueStore(defaultQueuePath());
    this.jiraSite = options.jiraSite !== undefined ? options.jiraSite : (process.env['FORGE_JIRA_SITE'] ?? null);
    this.mergeAllowedFn = options.mergeAllowed ?? queueMergeAllowed();
    this.gitLogFn = options.gitLog ?? defaultGitLog();
    this.driftFn = options.driftFn ?? gitDrift(readChainEnv());
  }

  private chain(): Map<string, ChainPacketState> {
    return foldChainState(this.journalCache.read(this.journalPath).events);
  }

  /** Item 7: a queue-sourced lane's `repo` and PR number are already on the queue item
   *  the moment it is routed and provisioned -- `computeRunPr` never finds them, because
   *  it only ever looks for a chain packet's `provisioned.branch`, and a queue lane has
   *  no chain packet. Without this, `checks`/`verdict`/`merged`/`title` stayed unset
   *  forever, `mergeable` answered "checks pending" for every queue PR for good, and
   *  `GET /merge-ready` never saw one. Fires the detail read in the background (never
   *  awaited by `GET /lanes` itself, so a poll never blocks on `gh`) and writes the
   *  answer into the same `run`-keyed cache `GET /run/:id/pr` reads, so the next poll
   *  (or the 60-second TTL's own re-check) sees it. */
  private scheduleQueuePrRefresh(run: string, repo: string, basic: LanePr): void {
    if (this.prRefreshInFlight.has(run)) return;
    this.prRefreshInFlight.add(run);
    const cachePath = prCachePath(this.forgeHomeDir);
    const task = (async () => {
      try {
        const cache = readPrCache(cachePath);
        const { cache: nextCache } = await computeQueuePr(
          run, repo, basic, cache, Date.now(), this.ghDetailLookup, this.attestationReader,
        );
        writePrCache(cachePath, nextCache);
      } finally {
        this.prRefreshInFlight.delete(run);
      }
    })();
    this.pendingPrRefreshes.push(task);
  }

  /** Item 11: a queue-sourced lane with a known branch and no PR on record at all --
   *  the worker's own ask already names one, but nothing ever wrote its number back
   *  onto the queue item. Looks it up once by branch, in the background, and writes
   *  the answer into the same `run`-keyed cache `scheduleQueuePrRefresh` and every
   *  other PR read here share, so the tile and the sheet both see it from the next
   *  poll. Only fires when nothing else has already found a PR for this run. */
  private scheduleBranchPrDiscovery(run: string, repo: string, branch: string): void {
    if (this.branchPrDiscoveryInFlight.has(run)) return;
    this.branchPrDiscoveryInFlight.add(run);
    const cachePath = prCachePath(this.forgeHomeDir);
    const task = (async () => {
      try {
        const cache = readPrCache(cachePath);
        const { cache: nextCache } = await computeBranchPr(run, repo, branch, cache, Date.now(), this.ghBranchLookup);
        writePrCache(cachePath, nextCache);
      } finally {
        this.branchPrDiscoveryInFlight.delete(run);
      }
    })();
    this.pendingPrRefreshes.push(task);
  }

  /** Test seam only (item 7): waits for every background PR-detail refresh `GET /lanes`
   *  has kicked off so far. Production code never calls this. */
  async settlePrRefreshes(): Promise<void> {
    await Promise.all(this.pendingPrRefreshes);
    this.pendingPrRefreshes = [];
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
      json(response, 200, this.lanesResponse(url.searchParams.get('all') === '1', url.searchParams.get('archived') === '1'));
      return true;
    }
    if (path === '/thread') {
      const url = new URL(request.url ?? '/', 'http://localhost');
      json(response, 200, this.threadResponse(url.searchParams.get('verbose') === '1'));
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
      const sub = runMatch[2] as 'thread' | 'pr' | 'sandbox' | 'cost' | 'journal' | 'story' | 'summary';
      const run = decodeURIComponent(id);
      if (sub === 'thread') {
        const url = new URL(request.url ?? '/', 'http://localhost');
        json(response, 200, this.runThreadResponse(run, url.searchParams.get('verbose') === '1'));
        return true;
      }
      if (sub === 'pr') {
        json(response, 200, await this.runPrResponse(run));
        return true;
      }
      if (sub === 'cost') {
        json(response, 200, this.runCostResponse(run));
        return true;
      }
      if (sub === 'journal') {
        json(response, 200, this.runJournalResponse(run));
        return true;
      }
      if (sub === 'story') {
        const url = new URL(request.url ?? '/', 'http://localhost');
        json(response, 200, await this.runStoryResponse(run, url.searchParams.get('verbose') === '1'));
        return true;
      }
      if (sub === 'summary') {
        json(response, 200, await this.runSummaryResponse(run));
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
   *  window on, the same default the board itself renders. `archived` (H1.7) includes a
   *  retired lane (`GET /lanes?archived=1`); a caller looking up one specific run by id
   *  always passes it, since a retired lane still answers on its own `/run/:id/*` routes. */
  lanesResponse(all = false, archived = false): LanesResponse {
    const now = Date.now();
    const fleet = this.journalCache.read(this.journalPath);
    const chain = this.chain();
    const prCache = readPrCache(prCachePath(this.forgeHomeDir));
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
      capOverrides: readCapsOverrides(capsOverridesPath(this.forgeHomeDir)).perRun ?? {},
      prFor: (run) => prCache[run]?.pr ?? null,
      tokensPerHour: (lane) => tokensPerHour(lane, fleet.runs[lane.slug]?.tokensUsed ?? 0, now),
      // Item 10: a queue item's own state and reason outrank a stale run state --
      // see `laneStateFor`'s own `queueParked` branch.
      queueStateFor: (run) => {
        const item = this.queueStore.all().find((row) => row.runKey === run);
        return item ? { state: item.state, reason: item.reason } : undefined;
      },
    };
    // `archived` bypasses the 24h finished-lane window the same way `all` does: an
    // operator asking to see everything ever retired must see a lane retired long ago,
    // never have it filtered out before the archived check even runs.
    const response = windowLanes(computeLanes(input, now), now, all || archived);
    const retired = readRetired(retiredPath(this.forgeHomeDir));
    const lanes = response.lanes
      .map((lane) => this.withHumanFields(lane, chain, prCache, now))
      .map((lane) => ({ ...lane, retiredAt: retired.get(lane.id) ?? null }))
      .filter((lane) => archived || lane.retiredAt === null);
    // 2026-09-08: what `Linkify` needs to turn a Jira key or a PR mention into a link
    // anywhere on the board -- `defaultRepo` is the first repo this response's own
    // lanes name, since a PR mention with no repo of its own falls back to it.
    const links = { jiraSite: this.jiraSite, defaultRepo: lanes.find((lane) => lane.repo)?.repo ?? null };
    return { ...response, lanes, links };
  }

  /** H1.1: `title`/`sourceUrl`, off whichever source actually named this lane -- a
   *  queue item (by `runKey`), a chain packet (by `launched.runKey`), or a registered
   *  run's own briefPath for a manual one. A probe needs none of these and titles the
   *  same way every time. */
  private withHumanFields(lane: Lane, chain: Map<string, ChainPacketState>, prCache: Cache, now: number): Lane {
    let briefPath: string | null = null;
    let prUrl: string | null = lane.pr?.url ?? null;
    // A queue item carries its own `repo` and a bare `pr` (no/url/draft) straight off
    // the queue's own log; a chain-kind lane's own `repo` already comes off the chain
    // packet in `buildLane`. Neither is a substitute for the richer `lane.pr` `/run/:id/pr`
    // caches (checks/verdict/merged) -- only a fallback for a queue lane nobody has
    // polled that route for yet, so `mergeable` and `plain` still have a repo and a PR
    // number to reason about instead of reading every ticket lane as "no PR yet".
    let repo = lane.repo;
    let pr = lane.pr;
    let queueItem: QueueItem | undefined;

    if (lane.kind === 'ticket' || lane.kind === 'brief' || lane.kind === 'hotfix' || lane.kind === 'self') {
      const item = this.queueStore.all().find((row) => row.runKey === lane.id);
      queueItem = item;
      briefPath = item?.briefPath ?? null;
      prUrl = prUrl ?? item?.pr?.url ?? null;
      repo = repo ?? item?.repo ?? null;
      pr = pr ?? item?.pr ?? null;
    } else if (lane.kind === 'chain') {
      const packet = packetForRun(chain, lane.id);
      briefPath = packet?.briefPath ?? null;
    } else if (lane.kind === 'manual') {
      briefPath = this.registry.get(lane.id)?.briefPath ?? null;
    }

    const briefHeading = briefPath ? readBriefHeading(briefPath, lane.ticket) : null;
    const { title, sourceUrl } = titleFor({ kind: lane.kind, ticket: lane.ticket, briefHeading, jiraSite: this.jiraSite, prUrl });
    const mergeable = mergeableFor({ pr, repo, mergeAllowed: this.mergeAllowedFn });
    const patched: Lane = { ...lane, title, sourceUrl, mergeable, repo, pr };
    // `plain` was built in `buildLane` off whatever `pr` the cache already had; a queue
    // lane's fallback `pr` above can change what it should say (a bare `pr` now exists
    // where there was none), so it is recomputed here rather than left stale.
    if (pr !== lane.pr) patched.plain = plainStatus(patched, { now: Date.now() });
    // Item 1: a merged PR outranks a stale queue state -- `buildLane`'s own
    // `laneStateFor` never sees this `pr` (it is resolved above, later than the fold
    // that set `state`), so a lane whose queue item still reads parked (or anything
    // else) reads merged the moment its PR, recorded or discovered above, actually is
    // one. Wins over the queue-item plain override below, since nothing about a merged
    // PR is still waiting on whatever the queue item says.
    const mergedNow = Boolean(pr?.merged) && patched.state !== 'merged';
    if (mergedNow) {
      patched.state = 'merged';
      patched.reason = null;
      patched.plain = prMergedSentence(pr);
    }
    // H1.2 fix: once a queue item exists, its own state and reason win over whatever
    // the run's own verdict says -- a run can sit `unverified` while the item it drives
    // is already three states further on in `review`. `plainForQueueItem` answers
    // `null` for every queue state it has no stronger opinion about (`queued`,
    // `planning`, `running`, `failed`), and the run-based sentence above stands there.
    if (queueItem && !mergedNow) {
      const verdict = this.queueVerdictFor({ ...queueItem, ...(repo ? { repo } : {}) });
      // The checks clause reads the lane's own PR facts (the cache), which the queue
      // item never carries.
      const withChecks = pr && queueItem.pr ? { ...queueItem, pr: { ...queueItem.pr, ...(pr.checks !== undefined ? { checks: pr.checks } : {}), ...(pr.merged !== undefined ? { merged: pr.merged } : {}) } } : queueItem;
      // Only a repo that is off the allow-list AND has a named owner reads as
      // controlled code; an unconfigured allow-list alone is not a fact about the repo.
      const backendOwner = process.env['FORGE_GH_BACKEND_OWNER'];
      const controlledOwner = repo && backendOwner && !this.mergeAllowedFn(repo) ? backendOwner : null;
      const queuePlain = plainForQueueItem(withChecks as typeof queueItem, verdict, controlledOwner);
      if (queuePlain) patched.plain = queuePlain;
    }
    // Item 7: a queue lane's repo+PR number are known the moment the queue item
    // exists, so a checks/verdict/merged read can be kicked off right here rather
    // than waiting for something to call `GET /run/:id/pr` first (which, for a queue
    // lane, nothing on the board ever does). A cache entry still inside its TTL means
    // a read has already landed recently -- no need to fire another one.
    if (queueItem && repo && pr?.no) {
      const cached = prCache[lane.id];
      if (!cached || now - cached.at >= PR_CACHE_TTL_MS) {
        this.scheduleQueuePrRefresh(lane.id, repo, pr);
      }
    }
    // Item 11: the run itself can already have opened a PR straight off its own
    // branch without the queue item ever recording it -- nothing above finds one,
    // since every path here needs a `pr.no` the queue item never got. A branch is
    // known the moment the item is provisioned (`queueItem.branch`), or off the
    // lane's own sandbox for a lane the queue never provisioned through; a cache
    // entry still inside its TTL (including a cached "none found") means a lookup has
    // already landed recently.
    if (queueItem && repo && !pr?.no) {
      const branch = queueItem.branch ?? lane.sandbox?.branch ?? null;
      if (branch) {
        const cached = prCache[lane.id];
        if (!cached || now - cached.at >= PR_CACHE_TTL_MS) {
          this.scheduleBranchPrDiscovery(lane.id, repo, branch);
        }
      }
    }
    // Item 9: `computeLanes` already stripped `plain`/`reason` once, but both of the
    // overrides above -- `plainStatus` recomputed for a queue lane's freshly-resolved
    // `pr`, and `plainForQueueItem`'s own read of the queue item's raw `reason` (which
    // can still carry an unshortened sha straight off a park reason, "checks are
    // failure on head <40 hex characters>") -- run after that strip, not before it.
    // The invariant this class promises -- no `plain`, `reason` or `status` leaves
    // `ConsoleReads` carrying a 40-character sha or a run id -- has to hold here too,
    // at the very end, or it only holds for whichever lanes this method never touched.
    if (patched.plain) patched.plain = shortenShas(stripMachineIds(patched.plain));
    if (patched.reason) patched.reason = shortenShas(stripMachineIds(patched.reason));
    // 2026-09-08: `now` mirrors whatever `plain` ended up saying above (the queue
    // item's own sentence when it had one, the run-based one otherwise); `you` reads
    // `mergeable`, which only exists once this function has computed it.
    patched.now = patched.plain;
    patched.you = computeYou(patched);
    return patched;
  }

  /** The council's verdict and coverage for a queue item's own review round, off the
   *  attestation the gate wrote at `item.attestationPath` -- `null` for an item with no
   *  attestation on record yet (never a council round, or the file has gone missing). */
  private queueVerdictFor(item: { attestationPath?: string | null; repo?: string | null; pr?: { no: number } | null }): QueueVerdict | null {
    // The queue item rarely carries the attestation path itself; the newest attestation
    // under attestations/<owner>/<name>/<pr>/ is the same record the PR facts read, so
    // the sentence and the PR line can never disagree about the verdict (seen live on
    // 2026-09-07: "the council has not posted a verdict yet" above "council PASS WITH NOTES").
    const path = item.attestationPath ?? (item.repo && item.pr?.no ? newestAttestationPath(item.repo, item.pr.no) : null);
    if (!path) return null;
    const attestation = readAttestationAtPath(path);
    if (!attestation) return null;
    return {
      verdict: attestation.verdict,
      reviewed: attestation.coverage.total - attestation.coverage.missing.length,
      total: attestation.coverage.total,
    };
  }

  private threadResponse(verbose = false): ThreadResponse {
    const now = Date.now();
    const persisted = readThread(threadPath(this.forgeHomeDir));
    const fleet = this.journalCache.read(this.journalPath);
    // H1.9 fix: a rail chip's `titleFor` seam -- the same title `GET /lanes` already
    // computed for this lane, so a chip reads "BBZ-99: ..." instead of shouting its
    // raw run id. `lanesResponse` is already the shared lookup every other run-scoped
    // route here uses (`runJournalResponse`, `runStoryResponse`).
    // Built once per call: `lanesResponse` reads every lane off disk, and calling it per
    // chip (hundreds of chips, on every feed event) held the event loop for seconds at a
    // time and made a 900-byte page take six seconds to answer (2026-09-07).
    //
    // Deliverable 6: every chain link (a handed-off successor run, not only the root)
    // maps to the same root lane's title -- a chip about the successor used to read its
    // own bare run id, since `GET /lanes` only ever carries the root's own id.
    // Item 8: every chip and echoed command on the rail names a lane through the one
    // shared `labelFor` (ticket key first, then title, then a manual lane's own slug),
    // never the lane's bare `title` -- that used to leave a long-titled lane's whole
    // title standing in for what should have read as its short ticket key.
    const titles = new Map<string, string>();
    for (const lane of this.lanesResponse(true, true).lanes) {
      const label = laneLabelFor(lane.id, (id) => (id === lane.id ? { ticket: lane.ticket, title: lane.title } : null));
      for (const link of chainLinks(fleet.runs, lane.id)) {
        titles.set(link.key, label);
      }
    }
    const titleFor = (id: string): string | null => titles.get(id) ?? null;
    return computeThread(persisted, fleet.events, now, this.inbox.open(), titleFor, {
      verbose, allAsks: this.inbox.all(),
    });
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
    const overridesPath = capsOverridesPath(this.forgeHomeDir);
    // A policy file with no `governor` block reads back as `{ dailyUsd: Infinity,
    // usdPerRun: {} }` (policy.ts's own `governorBudget` default) -- the only way to
    // tell that apart from a real, deliberately-unbounded budget is that a configured
    // one always sets at least one of the two. This is the enforcement on/off signal
    // only: the policy's own dollar-denominated numbers never feed into a token cap
    // here (see `caps-read.ts`'s own comment on why not).
    const governorConfigured = Number.isFinite(budget.dailyUsd) || Object.keys(budget.usdPerRun).length > 0;
    // `ensureHardTokens` writes 5x the effective daily cap into
    // `~/.forge/console/caps.json` the first time no console override declares one --
    // FD-7 never writes into the tracked model-policy.json (round 3: it used to, and a
    // smoke server running from a worktree dirtied that worktree's own tracked file).
    ensureHardTokens(overridesPath);
    const overrides = readCapsOverrides(overridesPath);
    return computeCaps({
      overrides,
      tokensToday: tokensToday(fleet.runs, now),
      governorConfigured,
    });
  }

  private proposalsResponse(): ProposalsResponse {
    const now = Date.now();
    const fleet = this.journalCache.read(this.journalPath);
    const tokensByRun = Object.fromEntries(Object.entries(fleet.runs).map(([run, state]) => [run, state.tokensUsed]));
    const existingRules = readRules(rulesPath(this.forgeHomeDir));
    return computeProposals(fleet.events, now, tokensByRun, existingRules);
  }

  private runThreadResponse(run: string, verbose = false): RunThreadResponse {
    const fleet = this.journalCache.read(this.journalPath);
    const result = computeRunThread(run, fleet.events, new RunInbox(run).all(), { verbose });
    return verbose ? { ...result, verbose: true } : result;
  }

  private async runPrResponse(run: string): Promise<RunPrResponse> {
    const now = Date.now();
    const cachePath = prCachePath(this.forgeHomeDir);
    const cache = readPrCache(cachePath);
    const { pr, cache: nextCache } = await computeRunPr(
      run, this.chain(), cache, now, this.ghLookup, this.ghDetailLookup, this.attestationReader,
    );
    if (pr) {
      if (nextCache !== cache) writePrCache(cachePath, nextCache);
      return { pr };
    }
    // Item 7: `computeRunPr` only ever finds a PR through a chain packet's
    // `provisioned.branch`; a queue-sourced lane has no chain packet at all, so this
    // route answered `{ pr: null }` for one forever even with a real, open PR. Its
    // queue item already carries `repo` and a bare `pr` off the queue's own log --
    // read the detail straight off those instead of a branch lookup that never had
    // anything to find.
    const item = this.queueStore.all().find((row) => row.runKey === run);
    if (item?.repo && item.pr) {
      const { pr: queuePr, cache: queueCache } = await computeQueuePr(
        run, item.repo, item.pr, cache, now, this.ghDetailLookup, this.attestationReader,
      );
      writePrCache(cachePath, queueCache);
      return { pr: queuePr };
    }
    if (nextCache !== cache) writePrCache(cachePath, nextCache);
    return { pr: null };
  }

  private runSandboxResponse(run: string): RunSandboxResponse {
    const sandbox = computeSandbox(run, this.chain(), this.registry.get(run));
    const logFile = existsSync(runsDir()) ? newestLogFile(runDir(run)) : undefined;
    return { sandbox, log: tailLogWithSeverity(logFile) };
  }

  private runCostResponse(run: string): RunCostResponse {
    const fleet = this.journalCache.read(this.journalPath);
    const runaway = this.lanesResponse(true, true).lanes.find((l) => l.id === run)?.runaway ?? false;
    return {
      steps: computeCostSteps(run, fleet.events),
      capEnforcementFailedJid: findCapEnforcementFailure(run, fleet.events, runaway),
    };
  }

  /** `GET /run/:id/journal`: needs the run's own already-computed `Lane` (for its state,
   *  cost and sandbox id) alongside the raw journal and chain, so it reads the same
   *  `Lane[]` the board itself renders rather than re-deriving those fields a second way. */
  private runJournalResponse(run: string): RunJournalResponse {
    const now = Date.now();
    const fleet = this.journalCache.read(this.journalPath);
    const chain = this.chain();
    const lane = this.lanesResponse(true, true).lanes.find((l) => l.id === run);
    if (!lane) return { entries: [] };
    return { entries: computeJournalNarrative(lane, fleet.events, packetForRun(chain, run), now) };
  }

  /** `GET /run/:id/story`: the ticket sheet's own narrative, folded from the same real
   *  sources every other route here reads -- the journal, the queue item, the
   *  attestation the gate wrote, and the worktree's own `git log`. A run this server
   *  has never heard of still answers with an empty story rather than a 404, the same
   *  honesty `runDetail` in `server.ts` already keeps for a packet that has not landed. */
  private async runStoryResponse(run: string, verbose = false): Promise<LaneStory> {
    const fleet = this.journalCache.read(this.journalPath);
    const chain = this.chain();
    const lane = this.lanesResponse(true, true).lanes.find((l) => l.id === run);
    const queueItem = this.queueStore.all().find((item) => item.runKey === run);
    const packet = packetForRun(chain, run);

    const links = chainLinks(fleet.runs, run);
    const runKeys = new Set(links.map((link) => link.key));
    // Story scoping (2026-09-08 finding): a lane with no packet at all used to match
    // `row.packetId === packet?.packetId`, which reads as `undefined === undefined` and
    // matched every packet-less row in the whole journal -- 16,132 of 16,173 rows on the
    // live board, every one of them a park belonging to some other run. `packet` is only
    // ever consulted when this lane actually has one.
    const events = fleet.events.filter((row) => (
      (row.run && runKeys.has(row.run)) || (packet !== undefined && row.packetId === packet.packetId)
    ));

    const briefPath = queueItem?.briefPath ?? packet?.briefPath ?? this.registry.get(run)?.briefPath ?? null;
    const briefText = briefPath && existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : null;

    const worktreePath = queueItem?.worktreePath ?? packet?.provisioned?.worktreePath ?? null;
    const range: GitLogRange = {
      base: queueItem?.base ?? null,
      since: queueItem?.createdAt ?? lane?.startedAt ?? Date.now(),
    };
    const gitCommits = worktreePath && existsSync(worktreePath) ? await this.gitLogFn(worktreePath, range) : [];

    let attestation;
    const repo = queueItem?.repo ?? packet?.repo ?? null;
    const prNo = queueItem?.pr?.no ?? lane?.pr?.no ?? null;
    if (repo && prNo) {
      const detail = await this.cachedDetail(repo, prNo);
      if (detail) {
        const found = readAttestation(repo, prNo, detail.headSha);
        attestation = found;
      }
    }

    const ticket = lane?.ticket
      ? { key: lane.ticket, url: lane.sourceUrl, summary: lane.title }
      : null;

    return computeLaneStory({
      id: run, title: lane?.title ?? null, kind: lane?.kind ?? 'manual', ticket, events, verbose,
      ...(queueItem ? { queueItem } : {}), ...(attestation ? { attestation } : {}),
      gitCommits, ...(briefPath ? { briefPath } : {}), ...(briefText ? { briefText } : {}),
    });
  }

  /** `GET /run/:id/summary` (2026-09-07): the ticket sheet's top summary block, folded
   *  from the same story `GET /run/:id/story` already builds plus a read of the PR's own
   *  title/body/checks, the attestation on disk for its current head, and git's own
   *  drift facts. Item 2: every `gh`/`git` fact here is cached per (repo, PR) for
   *  `PR_CACHE_TTL_MS` through `cachedDetail`/`cachedDrift` -- a warm sheet answers off
   *  that cache instead of repeating the same `gh pr view` and `git fetch` this same
   *  request's own `runStoryResponse` call already made. */
  async runSummaryResponse(run: string): Promise<LaneSummary> {
    const lane = this.lanesResponse(true, true).lanes.find((l) => l.id === run);
    if (!lane) {
      return { what: [], status: 'no such run', next: 'Nothing to do; this run is not on the board.', audit: null, readiness: null };
    }
    const story = await this.runStoryResponse(run);
    const queueItem = this.queueStore.all().find((item) => item.runKey === run);
    const chain = this.chain();
    const packet = packetForRun(chain, run);
    const repo = queueItem?.repo ?? packet?.repo ?? lane.repo ?? null;
    const prNo = queueItem?.pr?.no ?? lane.pr?.no ?? null;
    const base = queueItem?.base ?? null;

    let pr: PrFacts | null = null;
    let attestation;
    let headSha: string | null = null;
    let mergeable: Lane['mergeable'] | undefined;
    if (repo && prNo) {
      const detail = await this.cachedDetail(repo, prNo);
      if (detail) {
        headSha = detail.headSha;
        pr = {
          title: detail.title || lane.pr?.title || null, body: detail.body ?? null,
          checks: detail.checks, merged: detail.merged,
        };
        attestation = readAttestation(repo, prNo, detail.headSha);
        // Fresh, off the same `gh` read and attestation this summary already made --
        // never `lane.mergeable`, which can still be carrying the last board poll's
        // cached PR snapshot and disagree with the readiness line right next to it.
        mergeable = mergeableFor({
          pr: { no: prNo, url: lane.pr?.url ?? '', draft: detail.isDraft, checks: detail.checks, merged: detail.merged, verdict: attestation?.verdict ?? null },
          repo, mergeAllowed: this.mergeAllowedFn,
        });
      }
    }
    const drift = repo && prNo && base
      ? await this.cachedDrift({ repo, base, pr: prNo, headSha, attestationHead: attestation?.head ?? null })
      : { behindBase: null, headMoved: false };

    return computeLaneSummary({ lane, story, pr, attestation: attestation ?? null, drift, mergeable });
  }

  /** `GET /merge-ready` (2026-09-07 addition): the same per-PR readiness (checks, the
   *  council's verdict, the allow-list, and drift) `GET /run/:id/summary` computes for
   *  one lane's own ticket sheet, folded onto every row of the bulk preview so a person
   *  never has to open each sheet in turn to see why an item that looks ready is not.
   *  Reads off the same cached `lane.pr` `mergeReadyReportFrom` already used for its own
   *  ready/not-ready split -- this never repeats that split's own allow-list refusal,
   *  only adds the audit and drift facts on top of it. */
  async mergeReadyReport(): Promise<MergeReadyReport> {
    const lanes = this.lanesResponse(true).lanes;
    const base = mergeReadyReportFrom(lanes);

    const readinessFor = async (pr: LanePr, id: string): Promise<import('../../shared/console-model.js').LaneReadiness> => {
      const queueItem = this.queueStore.all().find((row) => row.runKey === id);
      const repo = queueItem?.repo ?? null;
      const baseBranch = queueItem?.base ?? null;
      const prFacts: PrFacts = { title: pr.title ?? null, body: null, checks: pr.checks ?? null, merged: pr.merged ?? null };
      const attestationPath = repo ? newestAttestationPath(repo, pr.no) : null;
      const attestation = attestationPath ? readAttestationAtPath(attestationPath) : undefined;
      const drift = repo && baseBranch
        ? await this.driftFn({ repo, base: baseBranch, pr: pr.no, headSha: null, attestationHead: attestation?.head ?? null })
        : { behindBase: null, headMoved: false };
      // The allow-list refusal already lives on `why` from `mergeReadyReportFrom`'s own
      // split; this augments with the audit and drift facts on top of it, so `mergeable`
      // here is always `{ ok: true }` -- never a second, possibly-disagreeing verdict on
      // the same allow-list question.
      return computeReadiness({ pr: prFacts, attestation: attestation ?? null, mergeable: { ok: true }, drift });
    };

    const ready = await Promise.all(base.ready.map(async (row) => ({ ...row, readiness: await readinessFor(row.pr, row.id) })));
    const notReady = await Promise.all(base.notReady.map(async (row) => ({ ...row, readiness: await readinessFor(row.pr, row.id) })));
    return { ready, notReady };
  }

  /** `POST /run/:id/recheck` (2026-09-07): the same facts `GET /run/:id/summary`
   *  computes, with the shared `pr-cache.json` entry for this run dropped first, so the
   *  board's own `lane.pr` (checks/verdict/merged) is refreshed on the next poll too,
   *  not only this one sheet's own summary (which already reads `gh` fresh every call). */
  async runRecheckResponse(run: string): Promise<LaneSummary> {
    const cachePath = prCachePath(this.forgeHomeDir);
    const cache = readPrCache(cachePath);
    if (cache[run]) {
      const next = { ...cache };
      delete next[run];
      writePrCache(cachePath, next);
    }
    // A recheck asks for today's truth, not the last 60s' worth of it -- drop this
    // process's own detail/drift caches too, or `runSummaryResponse` right below would
    // just hand back the same stale read Item 2's cache was built to skip repeating.
    this.detailCache.clear();
    this.driftCache.clear();
    return this.runSummaryResponse(run);
  }
}

/** Reads a brief file's own heading off disk for `withHumanFields`, or `null` for a
 *  path that does not exist (a queue item planned but not yet written its brief, a
 *  packet whose worker never ran) or does not parse -- never thrown. */
function readBriefHeading(path: string, ticket: string | null): string | null {
  if (!existsSync(path)) return null;
  try {
    return titleFromHeading(readFileSync(path, 'utf8'), ticket);
  } catch {
    return null;
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

/** The newest attestation file for a PR, by its recorded time, or null when none. */
function newestAttestationPath(repo: string, pr: number): string | null {
  const dir = join(forgeHome(), 'attestations', ...repo.split('/'), String(pr));
  if (!existsSync(dir)) return null;
  let best: { path: string; at: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { at?: { value?: number } | number };
      const at = typeof parsed.at === 'number' ? parsed.at : parsed.at?.value ?? 0;
      if (!best || at >= best.at) best = { path, at };
    } catch {
      // an unreadable record is not evidence of anything
    }
  }
  return best?.path ?? null;
}
