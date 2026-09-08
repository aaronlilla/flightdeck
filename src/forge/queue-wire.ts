/**
 * Production wiring for the intake queue in `intake/queue.ts`, the same split
 * `chain-wire.ts` keeps from `chain.ts`: nothing in `queue.ts` touches the network,
 * reads `~/.forge`, or reads `process.env`; every real Jira call and every real launch
 * dependency lives here instead, built once by `forge up` when `FORGE_QUEUE=1`.
 *
 * The launch side is not reinvented: `chainLauncher`, `chainGh`, `chainCouncil` and
 * `chainGate` from `chain-wire.ts` are reused outright, unchanged. The only new wiring
 * this file adds is Jira: `queueSearch` resolves a `query`/`backlog` add to ticket keys,
 * and `queuePlanner` turns a ticket (or a pasted brief) into a routed brief file, the
 * same two steps `chain-wire.ts#chainIntake` already runs for a poll-sourced packet,
 * just triggered by an operator's own add instead of a poll cycle.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chainCouncil, chainGate, chainGh, chainRebase, chainLauncher } from './chain-wire.js';
import { checkoutFor, repoKindFor as repoKindForEnv, type ChainEnv } from './chain-env.js';
import type { CliResult, ForgeDeps } from './cli.js';
import { countAddDel, REAL_GH } from './council/gh.js';
import type { Packet, PollSourceName, Watermark } from './contracts.js';
import { run as execRun } from './exec.js';
import type { QueueMergeDeps, QueuePlannedBrief, QueuePlanner, QueuePromoteDeps, QueueRuntimeDeps, QueueTicketSearch } from './intake/queue.js';
import { developDeployVerifier } from './intake/otaVerify.js';
import { appendRoutinesSection, loadRoutines, matchRoutines } from './self/routines.js';
import { routinesDir } from './paths.js';
import { createJiraFeed, createJiraWriteClient, type JiraConfig } from './intake/jira.js';
import { runQueueHandoff } from './intake/queueHandoff.js';
import type { PollItemDetail } from './intake/poller.js';
import { planFromPacket } from './intake/planner.js';
import { resolvePlanProvider } from './intake/reasoner.js';
import { parseRepoMap, routeRepo, repoFromBrief, ticketFromBrief } from './intake/repoRoute.js';
import { Journal } from './journal.js';
import { loadPolicy } from './policy.js';
import { queueBriefsDir, journalPath, killSwitchPath } from './paths.js';
import { reasonerFor } from './reasoner-claude.js';
import { readKillSwitch } from './supervisor.js';
import { readQueuePaused } from './console/queue-pause.js';

const JIRA_ENV_VARS = ['FORGE_JIRA_SITE', 'FORGE_JIRA_EMAIL', 'FORGE_JIRA_TOKEN'] as const;

/** `undefined` when any of `FORGE_JIRA_SITE`/`FORGE_JIRA_EMAIL`/`FORGE_JIRA_TOKEN` is
 *  unset -- read fresh on every call, never cached, so a credential set after `forge up`
 *  started still takes effect on the queue's next add or tick. */
export function jiraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiraConfig | undefined {
  const missing = JIRA_ENV_VARS.filter((name) => !env[name]);
  if (missing.length) return undefined;
  return {
    site: env['FORGE_JIRA_SITE']!, email: env['FORGE_JIRA_EMAIL']!, token: env['FORGE_JIRA_TOKEN']!,
  };
}

const EMPTY_WATERMARK: Watermark = { source: 'jira' as PollSourceName, committedAt: 0, idsAtCommittedAt: [] };

/** A.5: `backlog` is an operator's own filter text, never raw JQL on its own -- it is
 *  always joined onto a project's own backlog JQL before it reaches `searchKeys`, so a
 *  filter of "flaky" cannot accidentally sweep another team's board. `query` (a sprint
 *  or an epic) stays raw JQL, untouched by this function: the operator is expected to
 *  already know the JQL for those. Throws naming the missing variable rather than
 *  silently searching every project, the same honesty `queueSearch` already keeps for a
 *  missing Jira credential. */
export function buildBacklogJql(filter: string, env: NodeJS.ProcessEnv = process.env): string {
  const project = env['FORGE_BACKLOG_PROJECT'];
  if (!project) throw new Error('backlog: missing FORGE_BACKLOG_PROJECT');
  const escaped = filter.replace(/"/g, '\\"');
  return `project = ${project} AND statusCategory != Done AND text ~ "${escaped}"`;
}

/**
 * `queueSearch`: a `query`/`backlog` add resolves its JQL through the same
 * `createJiraFeed` a poll cycle already uses -- `fetchSince` ignores whatever
 * watermark it is handed (`jira.ts`'s own contract), so a fixed empty one reads
 * every match every time, which is exactly what a one-off add needs.
 *
 * Requirement 2's own honesty rule lives here: with no Jira credentials configured,
 * this throws a message naming exactly which environment variables are missing, rather
 * than resolving to zero tickets and looking like an empty result.
 */
export function queueSearch(configFn: () => JiraConfig | undefined = jiraConfigFromEnv): QueueTicketSearch {
  return {
    async searchKeys(jql) {
      const config = configFn();
      if (!config) {
        const missing = JIRA_ENV_VARS.filter((name) => !process.env[name]);
        throw new Error(`jira not configured: missing ${missing.join(', ')}`);
      }
      const feed = createJiraFeed({ ...config, jql });
      const items = await feed.fetchSince(EMPTY_WATERMARK);
      return items.map((item) => item.id);
    },
  };
}

/** The brief file id `planTicket` writes under, and therefore the run key
 *  `chain-wire.ts#runKeyForBrief` derives from its basename: the packet id (`queue-
 *  <ticket>`) joined to the queue item's own id, so a re-queued ticket never lands on
 *  the same brief file, and therefore never the same run key, as an earlier item for
 *  that ticket. See the 2026-09-08 13:35 BBZ-233 specimen in `planTicket` below. */
export function briefIdFor(packetId: string, itemId: string): string {
  return `${packetId}-${itemId}`;
}

function packetFor(ticket: string, repo: string, detail: PollItemDetail | undefined): Packet {
  return {
    id: `queue-${ticket}`,
    ticket,
    what: detail
      ? `${detail.summary} (${detail.issuetype}, ${detail.priority}, ${detail.status})`
      : `queued by ticket key, not yet triangulated`,
    where: 'jira',
    evidence: detail?.description ? [ticket, detail.description] : [ticket],
    confidence: 'low',
    repo,
    blockedBy: [],
    at: Date.now(),
  };
}

/**
 * `queuePlanner`: a ticket key becomes a routed brief the same way `chain-wire.ts`'s own
 * intake does -- one Jira lookup for the ticket's own text, `routeRepo` against
 * `FORGE_INTAKE_REPO_MAP`, then one `planFromPacket` call through the Reasoner. A pasted
 * brief skips both: there is no ticket to look up, so `routeRepo` runs against an empty
 * `labels`/`components`/`issuetype`, which only ever resolves through a `default` rule
 * in the map (or stays `'unknown'`, reported honestly rather than guessed at).
 */
export function queuePlanner(configFn: () => JiraConfig | undefined = jiraConfigFromEnv): QueuePlanner {
  const repoRules = parseRepoMap(process.env['FORGE_INTAKE_REPO_MAP']);
  const briefsDir = queueBriefsDir();
  mkdirSync(briefsDir, { recursive: true });

  // F.6: routines are the things this fleet has done more than once, written down once.
  // Every brief the queue writes carries the ones whose tags match the brief's own
  // words, so the worker reads them before it repeats the work.
  const routines = loadRoutines(routinesDir());
  async function writeBrief(id: string, text: string, repoKind?: string): Promise<string> {
    const path = join(briefsDir, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
    const keywords = [...new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])];
    const matched = matchRoutines({ ...(repoKind ? { repoKind } : {}), keywords: ['general', ...keywords] }, routines);
    writeFileSync(path, appendRoutinesSection(text, matched), 'utf8');
    return path;
  }

  return {
    async planTicket(ticket, itemId): Promise<QueuePlannedBrief> {
      const config = configFn();
      let repo = routeRepo(repoRules, { ticket, labels: [], components: [], issuetype: '' });
      let detail: PollItemDetail | undefined;
      if (config) {
        const feed = createJiraFeed({ ...config, jql: `key = ${ticket}` });
        const [item] = await feed.fetchSince(EMPTY_WATERMARK);
        detail = item?.detail;
        if (detail) {
          repo = routeRepo(repoRules, {
            ticket, labels: detail.labels ?? [], components: detail.components ?? [], issuetype: detail.issuetype,
          });
        }
      }
      const packet = packetFor(ticket, repo, detail);
      const journal = new Journal(journalPath());
      try {
        const reasoner = reasonerFor(resolvePlanProvider(loadPolicy().reasoner), { journal });
        const planned = await planFromPacket(packet, reasoner);
        const briefPath = await writeBrief(briefIdFor(planned.packetId, itemId), planned.text);
        return { ticket, repo, briefPath };
      } finally {
        journal.close();
      }
    },

    // A pasted brief has no ticket for the rules to match, so a `repo: owner/name` line
    // in the brief wins; without one the map's default applies as before. A `ticket:
    // KEY-123` line names the real Jira key: the brief file's own id stays a unique
    // synthetic string, but the item's `ticket` field (branch naming, jiraHandoff, routing)
    // takes the real key, so a hand-written brief reaches its own ticket's Jira handoff
    // instead of a synthetic `queue-brief-<timestamp>` one.
    async planBrief(text): Promise<QueuePlannedBrief> {
      const id = `queue-brief-${Date.now()}`;
      const ticket = ticketFromBrief(text) ?? id;
      const repo = repoFromBrief(text)
        ?? routeRepo(repoRules, { ticket, labels: [], components: [], issuetype: '' });
      const briefPath = await writeBrief(id, text);
      return { ticket, repo, briefPath };
    },

    // A.6: the `hotfix-` prefix is load-bearing: `chain-env.ts#branchFor` reads it off the
    // ticket string to route this item onto `hotfix/<slug>` instead of an ordinary feature
    // branch. A `ticket: KEY-123` line still wins for routing and handoff, same as
    // planBrief, while the brief file's own id keeps the `hotfix-` prefix branchFor needs.
    async planHotfix(text): Promise<QueuePlannedBrief> {
      const id = `hotfix-${Date.now()}`;
      const ticket = ticketFromBrief(text) ?? id;
      const repo = repoFromBrief(text)
        ?? routeRepo(repoRules, { ticket, labels: [], components: [], issuetype: '' });
      const briefPath = await writeBrief(
        id,
        `${text}\n\nThis is a hotfix: it ships to dev on Merge and to production only on a `
          + 'separate Promote click.',
      );
      return { ticket, repo, briefPath };
    },
  };
}

/** A.2: posts the council's own notes on the PR, through `REAL_GH.commentPr` --
 *  `advanceItem` itself never touches `gh`, so every real write funnels through here. */
export function queueCommentOnPr(): NonNullable<QueueRuntimeDeps['commentOnPr']> {
  return async ({ repo, pr, body }) => {
    await REAL_GH.commentPr(repo, pr, body);
  };
}

/** A.4: the backend ping -- a Jira assign to `FORGE_JIRA_BACKEND_OWNER_ACCOUNT` and a PR
 *  reviewer request naming `FORGE_GH_BACKEND_OWNER`, both skipped honestly (rather than
 *  guessed at) when the relevant environment variable is unset. */
export function queueBackendHandoff(
  configFn: () => JiraConfig | undefined = jiraConfigFromEnv,
): NonNullable<QueueRuntimeDeps['backendHandoff']> {
  return async ({ item, pr }) => {
    const ownerAccount = process.env['FORGE_JIRA_BACKEND_OWNER_ACCOUNT'];
    const ghReviewer = process.env['FORGE_GH_BACKEND_OWNER'];
    const config = configFn();
    if (ownerAccount && config && item.ticket) {
      await createJiraWriteClient(config).assign(item.ticket, ownerAccount);
    }
    if (ghReviewer && item.repo) {
      await REAL_GH.requestReviewer(item.repo, pr.no, ghReviewer);
    }
  };
}

/** A.3: the Jira write-back at review -- a comment in Aaron's voice, a QA assign/
 *  transition when those variables are set, and a remote link to the PR. Skipped
 *  honestly (never a guessed write) when no Jira credential is configured. */
export function queueJiraHandoff(
  configFn: () => JiraConfig | undefined = jiraConfigFromEnv,
): NonNullable<QueueRuntimeDeps['jiraHandoff']> {
  return async ({ item, pr }) => {
    const config = configFn();
    if (!config || !item.ticket) return;
    const journal = new Journal(journalPath());
    try {
      await runQueueHandoff(
        createJiraWriteClient(config),
        {
          ticket: item.ticket, prUrl: pr.url,
          what: `${item.ticket} reached review through the queue.`,
          testPlan: [],
        },
        {
          qaAccountId: process.env['FORGE_JIRA_QA_ACCOUNT'],
          qaTransitionId: process.env['FORGE_JIRA_QA_TRANSITION'],
        },
        (handoffEvent) => journal.append({ actor: 'queue', ...handoffEvent }),
      );
    } finally {
      journal.close();
    }
  };
}

/** A.8/A.9: the PR's own changed files and add/del counts, off `REAL_GH.viewPr` --
 *  the same read Council's own gate already makes for this PR, just made available to
 *  the queue itself rather than only living inside the `forge council` subprocess. */
export function queuePrSnapshot(): NonNullable<QueueRuntimeDeps['prSnapshot']> {
  return async (repo, pr) => {
    const snapshot = await REAL_GH.viewPr(repo, pr);
    return { files: snapshot.files, ...countAddDel(snapshot.diffText) };
  };
}

/** A.7: the Merge click's own allow-list, separate from `FORGE_CHAIN_MERGE` (which
 *  gates the unattended chain, a different decision) -- `FORGE_QUEUE_MERGE_REPOS`,
 *  comma-separated `owner/name` entries. */
export function queueMergeAllowed(env: NodeJS.ProcessEnv = process.env): (repo: string) => boolean {
  const repos = (env['FORGE_QUEUE_MERGE_REPOS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return (repo) => repos.includes(repo);
}

/** A.7: whether `.eas/workflows/publish-production.yml` exists on a repo's `develop`
 *  tip, read off the local checkout `FORGE_REPO_CHECKOUTS` already names for it --
 *  `Promote` reads this fresh on every click rather than assuming the workflow is
 *  there once and staying wrong after it lands (or is removed). No checkout configured
 *  for the repo reads as `false`, the same honest refusal as a genuinely missing file. */
export function queueProductionWorkflowExists(chainEnv: ChainEnv): (repo: string) => Promise<boolean> {
  return async (repo) => {
    const checkout = checkoutFor(chainEnv, repo);
    if (!checkout) return false;
    const result = await execRun({
      argv: ['git', '-C', checkout, 'cat-file', '-e', 'origin/develop:.eas/workflows/publish-production.yml'],
      cwd: checkout, owner: 'queue', cls: 'script',
    });
    return result.ok;
  };
}

/** Whether `feature/<branch>` is already merged into `origin/main` on the repo's
 *  checkout -- backs an `after: <slug>` entry naming no queue item. Fetches first so a
 *  merge that landed since the checkout was last touched still counts; a repo with no
 *  checkout configured, or a fetch that fails, answers `false` rather than guessing. */
export function queueBranchMerged(chainEnv: ChainEnv): NonNullable<QueueRuntimeDeps['branchMerged']> {
  return async (repo, branch) => {
    const checkout = checkoutFor(chainEnv, repo);
    if (!checkout) return false;
    const fetch = await execRun({
      argv: ['git', '-C', checkout, 'fetch', '--prune', 'origin'],
      cwd: checkout, owner: 'queue', cls: 'script',
    });
    if (!fetch.ok) return false;
    const result = await execRun({
      argv: ['git', '-C', checkout, 'merge-base', '--is-ancestor', `origin/${branch}`, 'origin/main'],
      cwd: checkout, owner: 'queue', cls: 'script',
    });
    return result.ok;
  };
}

/**
 * A.7: builds the Merge click's own dependencies -- ready for a caller with a
 * `ForgeDeps` in hand (`forge up`'s own wiring, `cli.ts`'s `up` case) to hand to
 * `QueueRoutesOptions.mergeDeps`. Not called by anything in this stream's own files:
 * `QueueRoutes` is constructed in `server.ts`, which this stream does not own, so
 * wiring this into a live route is the next hop for whichever stream builds that
 * construction call.
 */
export function queueMergeDeps(deps: ForgeDeps, store: QueueRuntimeDeps['store'], chainEnv?: ChainEnv): QueueMergeDeps {
  return {
    mergeAllowed: queueMergeAllowed(),
    gate: chainGate(deps),
    // B: the same council `advanceItem` already calls, so a moved head at Merge time
    // re-councils through the same real path a first gate round does.
    council: chainCouncil(deps),
    append: (event) => {
      const journal = new Journal(journalPath());
      try {
        return journal.append(event);
      } finally {
        journal.close();
      }
    },
    clock: () => Date.now(),
    store,
    ...(chainEnv ? { postMergeVerify: queuePostMergeVerify(chainEnv) } : {}),
  };
}

/** A.7: after a Merge lands, read the develop deploy's per-platform outcome off the EAS
 *  CLI (`intake/otaVerify.ts`), from the checkout `FORGE_REPO_CHECKOUTS` names for the
 *  repo. A repo with no checkout, or no workflow run inside the wait, answers undefined
 *  and the item's reason says so. Each CLI call is capped at 90 s, the whole wait at
 *  15 min -- a deploy that builds instead of publishing runs longer than that, and its
 *  `build` action is already the answer once the decide job has spoken. */
export function queuePostMergeVerify(chainEnv: ChainEnv): NonNullable<QueueMergeDeps['postMergeVerify']> {
  return async ({ repo, branch }) => {
    const checkout = checkoutFor(chainEnv, repo);
    if (!checkout) return undefined;
    const verify = developDeployVerifier({
      checkout,
      workflow: process.env['FORGE_DEPLOY_WORKFLOW'] ?? 'deploy-develop.yml',
      exec: async (argv, cwd) => {
        const result = await execRun({ argv, cwd, owner: 'queue', cls: 'script', fullOutput: true, raw: true, wall: 90_000 });
        return result.full ?? result.tail ?? '';
      },
    });
    return verify({ repo, branch, mergedAt: Date.now() });
  };
}

/** A.7: the Promote click's dependencies. The production dispatch itself is deliberately
 *  absent until the operator decides it should fire from a click (standing order 9), so
 *  Promote answers with the workflow's presence and a refusal naming that decision. */
export function queuePromoteDeps(chainEnv: ChainEnv): QueuePromoteDeps {
  return { productionWorkflowExists: queueProductionWorkflowExists(chainEnv) };
}

export function buildQueueRuntimeDeps(
  chainEnv: ChainEnv, fleetConfigDir: string, deps: ForgeDeps, store: QueueRuntimeDeps['store'], maxInFlight = 2,
): QueueRuntimeDeps {
  return {
    planner: queuePlanner(),
    launcher: chainLauncher(chainEnv, fleetConfigDir),
    gh: chainGh(),
    rebaseOnBase: chainRebase(),
    council: chainCouncil(deps),
    gate: chainGate(deps),
    clock: () => Date.now(),
    killSwitch: () => readKillSwitch(killSwitchPath()).engaged,
    paused: () => readQueuePaused(),
    maxInFlight,
    append: (event) => {
      const journal = new Journal(journalPath());
      try {
        return journal.append(event);
      } finally {
        journal.close();
      }
    },
    store,
    commentOnPr: queueCommentOnPr(),
    repoKindFor: (repo) => repoKindForEnv(chainEnv, repo),
    branchMerged: queueBranchMerged(chainEnv),
    backendHandoff: queueBackendHandoff(),
    jiraHandoff: queueJiraHandoff(),
    prSnapshot: queuePrSnapshot(),
    prMerged: async (repo, pr) => {
      const result = await execRun({
        argv: ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'mergedAt'],
        cwd: process.cwd(), owner: 'queue', cls: 'script', fullOutput: true, raw: true,
      });
      if (!result.ok) throw new Error('gh could not read the PR');
      return Boolean((JSON.parse(result.full ?? result.tail) as { mergedAt?: string | null }).mergedAt);
    },
  };
}

// Re-exported so `cli.ts` never needs its own import of `ForgeDeps`/`CliResult` just to
// satisfy this file's own type signature above.
export type { CliResult, ForgeDeps };
