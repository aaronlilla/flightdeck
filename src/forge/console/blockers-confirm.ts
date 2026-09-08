/**
 * `buildConfirmers`: one `Confirmer` per `BlockerKind`, the `blockers-route.ts` seam that
 * decides whether a claimed fix actually took.
 *
 * `question` and `process` read state this process already tracks (the inbox, the
 * registry); `integration` drives that row's own probe; `checks`, `billing` and `owner`
 * shell to `gh` through an injectable function, mirroring `reads.ts` and
 * `blockers-gather.ts` -- a specimen never shells out.
 */
import { run as execRun, type RunRequest } from '../exec.js';
import type { Inbox } from '../inbox.js';
import type { Registry } from '../registry.js';
import type { QueueStore } from '../intake/queueStore.js';
import type { IntegrationsRegistry } from './integrations.js';
import {
  defaultGhRunList, defaultGhRunView, type GhRunListFn, type GhRunViewFn, type GhRunViewJob,
} from './blockers-gather.js';
import type { Blocker, BlockerKind } from '../../shared/console-model.js';
import type { Confirmation, Confirmer } from './blockers-route.js';

export interface GhCheckRow {
  name: string;
  state: string;
}
export type GhPrChecksFn = (pr: number, repo: string) => Promise<GhCheckRow[]>;

export type GhPrMergedAtFn = (pr: number, repo: string) => Promise<string | null>;

export type GhRunRerunFn = (runId: string, repo: string) => Promise<void>;

function defaultGhPrChecks(spawnFn?: RunRequest['spawnFn']): GhPrChecksFn {
  return async (pr, repo) => {
    const result = await execRun({
      argv: ['gh', 'pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state'],
      cwd: process.cwd(), owner: 'console-blockers-checks', cls: 'script', fullOutput: true,
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (!result.ok) return [];
    try {
      return JSON.parse(result.full ?? result.tail) as GhCheckRow[];
    } catch {
      return [];
    }
  };
}

function defaultGhPrMergedAt(spawnFn?: RunRequest['spawnFn']): GhPrMergedAtFn {
  return async (pr, repo) => {
    const result = await execRun({
      argv: ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'mergedAt'],
      cwd: process.cwd(), owner: 'console-blockers-mergedat', cls: 'script', fullOutput: true,
      ...(spawnFn ? { spawnFn } : {}),
    });
    if (!result.ok) return null;
    try {
      const parsed = JSON.parse(result.full ?? result.tail) as { mergedAt?: string | null };
      return parsed.mergedAt ?? null;
    } catch {
      return null;
    }
  };
}

function defaultGhRunRerun(spawnFn?: RunRequest['spawnFn']): GhRunRerunFn {
  return async (runId, repo) => {
    await execRun({
      argv: ['gh', 'run', 'rerun', runId, '--repo', repo],
      cwd: process.cwd(), owner: 'console-blockers-rerun', cls: 'script',
      ...(spawnFn ? { spawnFn } : {}),
    });
  };
}

export interface BlockersConfirmDeps {
  inbox: Inbox;
  integrations: IntegrationsRegistry;
  registry: Registry;
  /** Where a `billing:<repo>` blocker's branch is looked up, by matching the PR number
   *  named in its own `detail` text against a queue item's own `pr.no`. Absent means the
   *  billing confirmer always answers "could not find the PR's branch to rerun its checks". */
  queueStore?: QueueStore;
  ghPrChecks?: GhPrChecksFn;
  ghPrMergedAt?: GhPrMergedAtFn;
  ghRunList?: GhRunListFn;
  ghRunView?: GhRunViewFn;
  ghRunRerun?: GhRunRerunFn;
  spawnFn?: RunRequest['spawnFn'];
  /** Overrides the billing confirmer's poll cadence (ms). Production default 4000; a
   *  specimen sets this near 0 so its own test does not actually wait 20s. */
  pollIntervalMs?: number;
  /** Overrides the billing confirmer's total poll budget (ms). Production default 20000. */
  pollBudgetMs?: number;
}

function parseAfterColon(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** `checks:<repo>#<pr>` / `owner:<repo>#<pr>` -- splits on the last `#`, since a repo name
 *  itself never carries one. */
function parseRepoPr(rest: string): { repo: string; pr: number } | null {
  const i = rest.lastIndexOf('#');
  if (i < 0) return null;
  const repo = rest.slice(0, i);
  const pr = Number(rest.slice(i + 1));
  if (!repo || !Number.isFinite(pr)) return null;
  return { repo, pr };
}

function questionConfirmer(inbox: Inbox): Confirmer {
  return async (blocker: Blocker): Promise<Confirmation> => {
    const key = parseAfterColon(blocker.id, 'question:');
    const stillOpen = inbox.open().some((entry) => entry.key === key);
    return stillOpen
      ? { ok: false, detail: 'the question is still open' }
      : { ok: true, detail: 'answered' };
  };
}

function integrationConfirmer(integrations: IntegrationsRegistry): Confirmer {
  return async (blocker: Blocker): Promise<Confirmation> => {
    const id = parseAfterColon(blocker.id, 'integration:');
    const response = await integrations.check(id);
    const row = response.items.find((item) => item.id === id);
    if (!row) return { ok: false, detail: `no such integration ${id}` };
    return row.status === 'ok'
      ? { ok: true, detail: `${row.name} is back up` }
      : { ok: false, detail: row.cause ?? `${row.name} is still ${row.status}` };
  };
}

function checksConfirmer(ghPrChecks: GhPrChecksFn): Confirmer {
  return async (blocker: Blocker): Promise<Confirmation> => {
    const target = parseRepoPr(parseAfterColon(blocker.id, 'checks:'));
    if (!target) return { ok: false, detail: 'could not read the PR from this blocker' };
    const rows = await ghPrChecks(target.pr, target.repo);
    if (rows.length === 0) return { ok: false, detail: 'no checks reported yet' };
    if (rows.some((row) => row.state === 'PENDING')) {
      return { ok: false, detail: 'checks are still running' };
    }
    if (rows.every((row) => row.state === 'SUCCESS')) {
      return { ok: true, detail: 'all checks are green' };
    }
    const failing = rows.filter((row) => row.state !== 'SUCCESS').map((row) => row.name);
    return { ok: false, detail: `still failing: ${failing.join(', ')}` };
  };
}

function ownerConfirmer(ghPrMergedAt: GhPrMergedAtFn): Confirmer {
  return async (blocker: Blocker): Promise<Confirmation> => {
    const target = parseRepoPr(parseAfterColon(blocker.id, 'owner:'));
    if (!target) return { ok: false, detail: 'could not read the PR from this blocker' };
    const mergedAt = await ghPrMergedAt(target.pr, target.repo);
    return mergedAt
      ? { ok: true, detail: `merged ${mergedAt}` }
      : { ok: false, detail: 'not merged yet' };
  };
}

function processConfirmer(registry: Registry): Confirmer {
  return async (blocker: Blocker): Promise<Confirmation> => {
    const laneIds = blocker.blocks.map((b) => b.laneId);
    const live = laneIds.find((laneId) => Boolean(registry.get(laneId)));
    return live
      ? { ok: true, detail: `${live} has a live process again` }
      : { ok: false, detail: 'still no live process' };
  };
}

const PR_IN_TEXT = /#(\d+)/;
const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_POLL_BUDGET_MS = 20_000;

function billingConfirmer(deps: {
  queueStore: QueueStore | undefined; ghRunList: GhRunListFn; ghRunView: GhRunViewFn;
  ghRunRerun: GhRunRerunFn; pollIntervalMs: number; pollBudgetMs: number;
}): Confirmer {
  return async (blocker: Blocker): Promise<Confirmation> => {
    const repo = parseAfterColon(blocker.id, 'billing:');
    const prMatch = PR_IN_TEXT.exec(blocker.detail);
    const pr = prMatch ? Number(prMatch[1]) : null;
    const item = pr !== null
      ? deps.queueStore?.all().find((row) => row.repo === repo && row.pr?.no === pr)
      : undefined;
    const branch = item?.branch ?? null;
    if (!branch) return { ok: false, detail: 'could not find the PR\'s branch to rerun its checks' };

    const listRow = await deps.ghRunList(repo, branch);
    if (!listRow) return { ok: false, detail: 'no failed run found to rerun' };

    await deps.ghRunRerun(String(listRow.databaseId), repo);

    const deadline = Date.now() + deps.pollBudgetMs;
    let lastJobs: GhRunViewJob[] = [];
    while (Date.now() < deadline) {
      const view = await deps.ghRunView(String(listRow.databaseId), repo);
      lastJobs = view?.jobs ?? [];
      const started = lastJobs.find((job) => job.startedAt);
      if (started) {
        return { ok: true, detail: `${started.name ?? 'a job'} started` };
      }
      await new Promise((resolve) => { setTimeout(resolve, deps.pollIntervalMs); });
    }
    return { ok: false, detail: 'the rerun has not started yet' };
  };
}

/** One `Confirmer` per `BlockerKind`, ready to hand to `BlockersRoutesOptions.confirmers`. */
export function buildConfirmers(deps: BlockersConfirmDeps): Partial<Record<BlockerKind, Confirmer>> {
  const ghPrChecks = deps.ghPrChecks ?? defaultGhPrChecks(deps.spawnFn);
  const ghPrMergedAt = deps.ghPrMergedAt ?? defaultGhPrMergedAt(deps.spawnFn);
  const ghRunRerun = deps.ghRunRerun ?? defaultGhRunRerun(deps.spawnFn);
  const ghRunList = deps.ghRunList ?? defaultGhRunList(deps.spawnFn);
  const ghRunView = deps.ghRunView ?? defaultGhRunView(deps.spawnFn);
  return {
    question: questionConfirmer(deps.inbox),
    integration: integrationConfirmer(deps.integrations),
    checks: checksConfirmer(ghPrChecks),
    owner: ownerConfirmer(ghPrMergedAt),
    process: processConfirmer(deps.registry),
    billing: billingConfirmer({
      queueStore: deps.queueStore, ghRunList, ghRunView, ghRunRerun,
      pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      pollBudgetMs: deps.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS,
    }),
  };
}
