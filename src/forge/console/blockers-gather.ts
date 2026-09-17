/**
 * `gather()` for `GET /blockers`: turns the inbox, the integrations registry, the lane
 * view and a live `gh` reader into `DetectionInputs`, the shape `detectBlockers`
 * (`blockers.ts`) takes.
 *
 * Every `gh` call goes through `execRun` with an injectable `spawnFn`, the same seam
 * `reads.ts` and `integrations.ts` already use; a specimen replaces `ghRunList`/
 * `ghRunView` directly and never shells out. The billing read (one `gh run list` plus one
 * `gh run view` per repo+branch with a failing PR) is cached in memory for 60 seconds so a
 * board poll never re-shells for the same lane a few seconds later.
 */
import { run as execRun, type RunRequest } from '../exec.js';
import type { Inbox } from '../inbox.js';
import type { Registry } from '../registry.js';
import type { QueueStore } from '../intake/queueStore.js';
import { askContextForRuns } from './askContext.js';
import type {
  AskInput, BillingSignalInput, DetectionInputs, IntegrationInput, LaneInput,
} from './blockers.js';
import type { IntegrationsRegistry } from './integrations.js';
import type { IntegrationStatus, LanesResponse } from '../../shared/console-model.js';

const BILLING_CACHE_MS = 60_000;
const BILLING_WINDOW_MS = 10_000;
const BILLING_MESSAGE = /billing|spending limit|payments have failed/i;

/** `gh run list --repo <repo> --branch <branch> --limit 1 --json databaseId,conclusion,createdAt,updatedAt`. */
export interface GhRunListRow {
  databaseId: number;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
}
export type GhRunListFn = (repo: string, branch: string) => Promise<GhRunListRow | undefined>;

export interface GhRunViewStep {
  name?: string;
  conclusion?: string | null;
}
export interface GhRunViewJob {
  name?: string;
  steps?: GhRunViewStep[];
  /** Present once a job has actually started -- `blockers-confirm.ts`'s billing confirmer
   *  polls for this after a `gh run rerun`. */
  startedAt?: string | null;
}
export interface GhRunViewResult {
  jobs: GhRunViewJob[];
}
export type GhRunViewFn = (runId: string, repo: string) => Promise<GhRunViewResult | undefined>;

export function defaultGhRunList(spawnFn?: RunRequest['spawnFn']): GhRunListFn {
  return async (repo, branch) => {
    const result = await execRun({
      argv: [
        'gh', 'run', 'list', '--repo', repo, '--branch', branch, '--limit', '1', '--json',
        'databaseId,conclusion,createdAt,updatedAt',
      ],
      cwd: process.cwd(), owner: 'console-blockers-runlist', cls: 'script', fullOutput: true,
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (!result.ok) return undefined;
    try {
      const rows = JSON.parse(result.full ?? result.tail) as GhRunListRow[];
      return rows[0];
    } catch {
      return undefined;
    }
  };
}

export function defaultGhRunView(spawnFn?: RunRequest['spawnFn']): GhRunViewFn {
  return async (runId, repo) => {
    const result = await execRun({
      argv: ['gh', 'run', 'view', runId, '--repo', repo, '--json', 'jobs'],
      cwd: process.cwd(), owner: 'console-blockers-runview', cls: 'script', fullOutput: true,
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (!result.ok) return undefined;
    try {
      return JSON.parse(result.full ?? result.tail) as GhRunViewResult;
    } catch {
      return undefined;
    }
  };
}

/** A run refused inside 10s with no steps at all reads as a billing/spending-limit block
 *  the same way a payment failure does on GitHub's own runner queue; any job or step
 *  naming billing, a spending limit or a failed payment is the direct case. Neither on
 *  its own proves anything else -- a run that ran real steps and merely failed them is an
 *  ordinary red check, not a billing block. */
function billingMessageFrom(row: GhRunListRow, view: GhRunViewResult): string | null {
  const finishedMs = new Date(row.updatedAt).getTime() - new Date(row.createdAt).getTime();
  const stepsEmpty = view.jobs.every((job) => !job.steps || job.steps.length === 0);
  if (stepsEmpty && finishedMs >= 0 && finishedMs < BILLING_WINDOW_MS) {
    return 'the run finished with no steps in under 10s, which reads as a billing refusal';
  }
  for (const job of view.jobs) {
    if (job.name && BILLING_MESSAGE.test(job.name)) return job.name;
    for (const step of job.steps ?? []) {
      if (step.name && BILLING_MESSAGE.test(step.name)) return step.name;
    }
  }
  return null;
}

interface BillingCacheEntry {
  at: number;
  row: BillingSignalInput | null;
}

export interface BlockersGatherDeps {
  inbox: Inbox;
  integrations: IntegrationsRegistry;
  /** The same `Lane[]` `ConsoleReads.lanesResponse(true, false)` renders. */
  lanesView: () => LanesResponse;
  registry: Registry;
  /** Where a lane's own branch is looked up for the `gh run list --branch` read. Absent
   *  means no billing signal is ever gathered -- a lane not sourced from the queue carries
   *  no branch this module can otherwise learn. */
  queueStore?: QueueStore;
  jiraSite?: string | null;
  ghRunList?: GhRunListFn;
  ghRunView?: GhRunViewFn;
  spawnFn?: RunRequest['spawnFn'];
  now?: () => number;
}

const KNOWN_INTEGRATION_STATUSES = new Set<IntegrationInput['status']>(['ok', 'off', 'down', 'checking']);

function narrowIntegrationStatus(status: IntegrationStatus): IntegrationInput['status'] {
  return KNOWN_INTEGRATION_STATUSES.has(status as IntegrationInput['status'])
    ? (status as IntegrationInput['status'])
    : 'checking';
}

async function billingSignalFor(
  lane: LanesResponse['lanes'][number], deps: BlockersGatherDeps,
  ghRunList: GhRunListFn, ghRunView: GhRunViewFn, cache: Map<string, BillingCacheEntry>, now: number,
): Promise<BillingSignalInput | null> {
  if (!lane.repo || !lane.pr || lane.pr.checks !== 'failure') return null;
  const branch = deps.queueStore?.all().find((item) => item.runKey === lane.id)?.branch ?? null;
  if (!branch) return null;

  const cacheKey = `${lane.repo}#${branch}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < BILLING_CACHE_MS) return cached.row;

  const listRow = await ghRunList(lane.repo, branch);
  if (!listRow) {
    cache.set(cacheKey, { at: now, row: null });
    return null;
  }
  const view = await ghRunView(String(listRow.databaseId), lane.repo);
  if (!view) {
    cache.set(cacheKey, { at: now, row: null });
    return null;
  }
  const message = billingMessageFrom(listRow, view);
  const row = message
    ? { repo: lane.repo, pr: lane.pr.no, runId: String(listRow.databaseId), headSha: '', message }
    : null;
  cache.set(cacheKey, { at: now, row });
  return row;
}

/**
 * Builds the `DetectionInputs` reader `blockers-route.ts`'s `gather` option takes.
 * Returned as a closure holding the billing cache, so the same instance is reused across
 * every poll a `ForgeServer` makes.
 */
export function gatherBlockers(deps: BlockersGatherDeps): () => Promise<DetectionInputs> {
  const ghRunList = deps.ghRunList ?? defaultGhRunList(deps.spawnFn);
  const ghRunView = deps.ghRunView ?? defaultGhRunView(deps.spawnFn);
  const billingCache = new Map<string, BillingCacheEntry>();

  return async (): Promise<DetectionInputs> => {
    const now = deps.now ? deps.now() : Date.now();

    const asks: AskInput[] = deps.inbox.open().map((entry) => ({
      key: entry.key, question: entry.question, runs: entry.runs, at: entry.at,
      ...(entry.answer !== undefined ? { answer: entry.answer } : {}),
      ...(entry.ticket !== undefined ? { ticket: entry.ticket } : {}),
    }));

    const integrationsResponse = await deps.integrations.list();
    const integrations: IntegrationInput[] = integrationsResponse.items.map((row) => ({
      id: row.id, name: row.name, status: narrowIntegrationStatus(row.status), cause: row.cause,
      fix: row.fix, fixLabel: row.fixLabel, since: row.since, dependents: row.dependents,
    }));

    const view = deps.lanesView();
    const lanes: LaneInput[] = view.lanes.map((lane) => ({
      id: lane.id, title: lane.title, ticket: lane.ticket, repo: lane.repo, state: lane.state, observedAt: lane.observedAt,
      pr: lane.pr ? { no: lane.pr.no, checks: lane.pr.checks ?? null } : null,
      mergeable: lane.mergeable,
    }));

    const registryLive = new Set(
      view.lanes.filter((lane) => Boolean(deps.registry.get(lane.id))).map((lane) => lane.id),
    );

    const failing = view.lanes.filter((lane) => lane.repo && lane.pr && lane.pr.checks === 'failure');
    const billingRows = await Promise.all(
      failing.map((lane) => billingSignalFor(lane, deps, ghRunList, ghRunView, billingCache, now)),
    );
    const billing = billingRows.filter((row): row is BillingSignalInput => row !== null);

    // A question about work that no longer exists is not a question: answering it posts
    // to a queue item that has been pruned. 90 of the 92 on the board were in that state
    // on 2026-09-12. Without a queue store to ask, every question counts as live, which
    // is what this did before and never hides a real one.
    const askInput = { items: deps.queueStore?.all() ?? [], laneIds: new Set(view.lanes.map((lane) => lane.id)) };
    const askAlive = deps.queueStore
      ? (runs: readonly string[]): boolean => askContextForRuns(runs, askInput).live
      : undefined;

    return {
      now, asks, integrations, lanes, billing, registryLive,
      ...(askAlive ? { askAlive } : {}),
      ...(deps.jiraSite ? { jiraSite: deps.jiraSite } : {}),
    };
  };
}
