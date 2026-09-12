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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chainCouncil, chainGate, chainGh, chainRebase, chainLauncher, chainLaunchGoal } from './chain-wire.js';
import {
  checkoutFor, declaredRepoKind, repoKindFor as repoKindForEnv, type ChainEnv,
} from './chain-env.js';
import type { CliResult, ForgeDeps } from './cli.js';
import { autoMergeAllowed } from './council/risk.js';
import { conclusionOf, countAddDel, guardedCommentPr, REAL_GH, type GhWriter } from './council/gh.js';
import type { Packet, PollSourceName, Watermark } from './contracts.js';
import { run as execRun } from './exec.js';
import type {
  QueueMergeDeps, QueuePlannedBrief, QueuePlanner, QueuePlanOutcome, QueuePromoteDeps, QueueRuntimeDeps, QueueTicketSearch,
} from './intake/queue.js';
import { asksForItem, planTicketWithInterview } from './intake/interviewPlanner.js';
import { InterviewStore } from './intake/interviewStore.js';
import { scoutAnswer } from './intake/scout.js';
import { Inbox } from './inbox.js';
import { gitSquashMergeToBase, type GitRunFn } from './intake/gitMerge.js';
import { developDeployVerifier } from './intake/otaVerify.js';
import { appendRoutinesSection, loadRoutines, matchRoutines } from './self/routines.js';
import { routinesDir } from './paths.js';
import { createJiraFeed, createJiraWriteClient, type JiraConfig } from './intake/jira.js';
import { runQueueHandoff } from './intake/queueHandoff.js';
import type { PollItemDetail } from './intake/poller.js';
import { resolvePlanProvider } from './intake/reasoner.js';
import { parseRepoMap, routeRepo, repoFromBrief, ticketFromBrief } from './intake/repoRoute.js';
import { Journal } from './journal.js';
import { loadPolicy } from './policy.js';
import { inboxDir, interviewRecordsDir, queueBriefsDir, journalPath, killSwitchPath, registryDir } from './paths.js';
import { processAlive, Registry } from './registry.js';
import { reasonerFor } from './reasoner-claude.js';
import { readKillSwitch } from './supervisor.js';
import { readQueuePaused } from './console/queue-pause.js';
import { readQueueWidth } from './console/queue-width.js';

// `queue-route.ts` reads the live width through this re-export, mirroring the inline
// `readPaused: () => readQueuePaused()` field `buildQueueRuntimeDeps` already builds
// below -- the same live-off-disk pattern, just not tied to a `QueueRuntimeDeps` field.
export { readQueueWidth, writeQueueWidth } from './console/queue-width.js';

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
 * `FORGE_INTAKE_REPO_MAP`, then the interview hop (`intake/interviewPlanner.ts`). A pasted
 * brief skips both: there is no ticket to look up, so `routeRepo` runs against an empty
 * `labels`/`components`/`issuetype`, which only ever resolves through a `default` rule
 * in the map (or stays `'unknown'`, reported honestly rather than guessed at).
 */
export function queuePlanner(
  configFn: () => JiraConfig | undefined = jiraConfigFromEnv,
  chainEnv?: ChainEnv,
): QueuePlanner {
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
    async planTicket(ticket, itemId): Promise<QueuePlanOutcome> {
      // An item already holding on an unanswered question is answered before the Jira
      // lookup, not after it. Without this, a question left overnight on a 15-second tick
      // made thousands of Jira reads whose result was thrown away, which also made the
      // planner's own "a held item costs nothing per tick" claim false. Found by code
      // review, 2026-09-11.
      const held = asksForItem(new Inbox(inboxDir()), itemId);
      if (held.length && held.some((ask) => ask.answer === undefined)) {
        return { waiting: 'interview', asks: held.filter((ask) => ask.answer === undefined).length };
      }
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
        // R-76: planning a ticket is an interview first. `planTicketWithInterview` owns
        // the whole hop -- it may answer `waiting` (a question is out with somebody) or
        // `backend` (this ticket is not ours to build), and the queue handles both.
        return await planTicketWithInterview(ticket, itemId, {
          reasoner,
          inbox: new Inbox(inboxDir()),
          records: new InterviewStore(interviewRecordsDir()),
          packetFor: async () => packet,
          scout: async (question) => {
            // The checkout comes from the repository map, never from the repository's
            // name: `checkoutFor`'s own contract. Guessing it from `workspaceRoot()` plus
            // the basename produced a real directory on this machine and nowhere else,
            // and a grep in a directory that is not there answers "(no matches)" -- which
            // reads as "the code says nothing", and lands in the brief as settled fact.
            // Found by code review, 2026-09-11.
            const checkout = chainEnv ? checkoutFor(chainEnv, repo) : undefined;
            if (!checkout) {
              return {
                answered: false,
                text: `no checkout is configured for ${repo}, so the code could not be searched`,
              };
            }
            return scoutAnswer(question, {
              cwd: checkout,
              owner: `interview-${itemId}`,
              reasoner,
            });
          },
          writeBriefFile: async ({ text }: { text: string }) => ({
            briefPath: await writeBrief(briefIdFor(packet.id, itemId), text),
            repo,
          }),
          append: (row: { event: string; [key: string]: unknown }) => { journal.append(row as never); },
        });
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

/** A.2: posts the council's own notes on the PR, through `guardedCommentPr` (order 19) --
 *  `advanceItem` itself never touches `gh`, so every real write funnels through here, and
 *  a DENY parks the item with the refusal reason rather than posting an unreadable
 *  comment. */
export function queueCommentOnPr(): NonNullable<QueueRuntimeDeps['commentOnPr']> {
  return async ({ repo, pr, body }) => {
    const refused = await guardedCommentPr(REAL_GH, repo, pr, body, (refusal) => {
      const journal = new Journal(journalPath());
      try {
        journal.append({
          event: 'readability.refused', run: `${repo}#${pr}`, actor: 'queue',
          reason: refusal.reason,
        });
      } finally {
        journal.close();
      }
    });
    if (refused === null) return;
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

/**
 * Item 16, 2026-09-12: at review, mark the pull request ready and post the ship
 * prediction as a comment. Both are writes a person would otherwise do by hand, and
 * leaving the pull request a draft means nobody can merge it at all.
 *
 * `readyPr` on an already-ready pull request is a no-op. The comment is NOT: a second
 * pass over the same item leaves a second prediction. The body write this replaced
 * carried a marker for that, and a comment has nowhere to put one -- named in the
 * finishing work rather than left implied (code review, 2026-09-12).
 */
/**
 * Item 16, 2026-09-12: whether a repo builds a mobile app, so a ship prediction means
 * anything for it.
 *
 * Evidence rather than configuration, after two rounds of the configuration reading
 * being wrong in opposite directions: `repoKindFor` means "not backend" and would have
 * put an Android and iOS ship path on every Node repo here, and the declared kind is
 * unset in the common case, which turned the feature off entirely without saying so.
 * An `android` or `ios` directory in the checkout is the thing that actually decides
 * whether there is a build to predict. A repo declaring `frontend` outright is taken
 * at its word; a repo with no checkout configured cannot be read, and answers no.
 */
export function mobileRepoAt(chainEnv: ChainEnv | undefined, repo: string): boolean {
  if (!chainEnv) return false;
  if (declaredRepoKind(chainEnv, repo) === 'frontend') return true;
  const checkout = checkoutFor(chainEnv, repo);
  if (!checkout) return false;
  return existsSync(join(checkout, 'android')) || existsSync(join(checkout, 'ios'));
}

export function queueReadyPrWithPrediction(
  gh: Pick<GhWriter, 'readyPr' | 'commentPr'> = REAL_GH,
  onRefused?: (reason: string) => void,
): NonNullable<QueueRuntimeDeps['readyPrWithPrediction']> {
  return async ({ item, pr, prediction }) => {
    if (!item.repo) return { readied: false };
    const ready = await gh.readyPr(item.repo, pr.no);
    // A non-zero exit here is usually "there was nothing to do": the gate readies and
    // merges on the auto-merge path before this runs. The message for a merged pull
    // request says it is CLOSED, so matching only on "merged" wrote a false failure row
    // on every successful auto-merge (code review, 2026-09-12).
    const nothingToDo = ready.returncode !== 0
      // `ready for review` is gone: `gh pr ready`'s own usage text contains it, so an
      // argument error printed help, matched, was swallowed, and the pull request was
      // recorded ready while still a draft (code review, 2026-09-12).
      && /not a draft|is closed|already merged/i.test(ready.stderr);
    if (ready.returncode !== 0 && !nothingToDo) {
      throw new Error(`gh pr ready failed: ${ready.stderr.slice(0, 300)}`);
    }
    // A closed pull request was never readied, and saying otherwise records it as
    // mergeable when it is not. It still gets the prediction: whoever reopens it wants
    // to know what merging costs.
    const readied = ready.returncode === 0 || !/is closed/i.test(ready.stderr);

    // The prediction is a COMMENT, not an edit to the body (2026-09-12). Appending to
    // the body meant reading it back first, and the only read available merges stdout
    // with stderr into one buffer -- a warning from the read would have been written
    // into somebody's prose, silently, with nothing parsing the result. A comment
    // needs no read at all, so the corruption class is gone rather than guarded.
    //
    // Through `guardedCommentPr`, which `council/gh.ts` states is the one gate every
    // pull request comment goes through; calling `commentPr` directly skipped the
    // readability verdict and its refusal row (code review, 2026-09-12).
    const commented = await guardedCommentPr(gh, item.repo, pr.no, prediction, (refusal) => {
      onRefused?.(refusal.reason);
    });
    if (commented === null) return { readied, predictionError: 'refused by readability' };
    if (commented.returncode !== 0) {
      return { readied, predictionError: commented.stderr.slice(0, 300) };
    }
    return { readied };
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

/** R-22: routes the Merge click's actual merge through git instead of `gh pr merge`,
 *  against the repo's own `FORGE_REPO_CHECKOUTS` entry on the base branch. A repo with no
 *  checkout configured refuses rather than guessing at a path. Wraps `execRun` as a
 *  `GitRunFn` so `gitSquashMergeToBase` runs through the same budgeted git call every
 *  other queue-wire function already uses. */
export function queueGitMerge(chainEnv: ChainEnv): NonNullable<QueueMergeDeps['gitMerge']> {
  const runGit: GitRunFn = async (argv, cwd) => {
    const result = await execRun({ argv: ['git', ...argv], cwd, owner: 'queue', cls: 'script' });
    return { ok: result.ok, stdout: result.tail };
  };
  return async ({ repo, base, branch, subject, body }) => {
    const checkoutDir = checkoutFor(chainEnv, repo);
    if (!checkoutDir) return { ok: false, reason: `no checkout configured for ${repo}` };
    return gitSquashMergeToBase({ checkoutDir, base, branch, subject, body }, runGit);
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
    ...(chainEnv ? { postMergeVerify: queuePostMergeVerify(chainEnv), gitMerge: queueGitMerge(chainEnv) } : {}),
  };
}

/** A.7: after a Merge lands, read the develop deploy's per-platform outcome off the EAS
 *  CLI (`intake/otaVerify.ts`), from the checkout `FORGE_REPO_CHECKOUTS` names for the
 *  repo. A repo with no checkout, or no workflow run inside the wait, answers undefined
 *  and the item's reason says so. Each CLI call is capped at 90 s, the whole wait at
 *  15 min -- a deploy that builds instead of publishing runs longer than that, and its
 *  `build` action is already the answer once the decide job has spoken. */
export function queuePostMergeVerify(chainEnv: ChainEnv): NonNullable<QueueMergeDeps['postMergeVerify']> {
  return async ({ repo, branch, mergeSha }) => {
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
    return verify({ repo, branch, mergedAt: Date.now(), ...(mergeSha ? { mergeSha } : {}) });
  };
}

/** A.7: the Promote click's dependencies. The production dispatch itself is deliberately
 *  absent until the operator decides it should fire from a click (standing order 9), so
 *  Promote answers with the workflow's presence and a refusal naming that decision. */
export function queuePromoteDeps(chainEnv: ChainEnv): QueuePromoteDeps {
  return { productionWorkflowExists: queueProductionWorkflowExists(chainEnv) };
}

export function buildQueueRuntimeDeps(
  chainEnv: ChainEnv, configDirFor: () => string, deps: ForgeDeps, store: QueueRuntimeDeps['store'],
  maxInFlight: () => number = readQueueWidth,
): QueueRuntimeDeps {
  return {
    planner: queuePlanner(jiraConfigFromEnv, chainEnv),
    launcher: chainLauncher(chainEnv, configDirFor),
    launchGoal: chainLaunchGoal(configDirFor),
    gh: chainGh(),
    rebaseOnBase: chainRebase(),
    council: chainCouncil(deps),
    gate: chainGate(deps),
    clock: () => Date.now(),
    killSwitch: () => readKillSwitch(killSwitchPath()).engaged,
    paused: () => readQueuePaused(),
    // Called fresh on every tick, same as `paused` above -- `readQueueWidth` (default)
    // re-reads `queueWidthPath()` off disk each time, so a `POST /queue/width` takes
    // effect on the next tick with no restart and no rebuilt deps object.
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
    // A queued item's own `repo` is null until it is planned, which happens after the
    // after: gate runs -- see `mergedOnKnownRepo` in `intake/queue.ts` for why this
    // fallback list, not `item.repo`, is what a real item actually resolves a
    // merged-branch after: entry against.
    mergeCheckRepos: chainEnv.checkouts.map((entry) => entry.repo),
    backendHandoff: queueBackendHandoff(),
    jiraHandoff: queueJiraHandoff(),
    mobileRepo: (repo) => mobileRepoAt(chainEnv, repo),
    readyPrWithPrediction: queueReadyPrWithPrediction(REAL_GH, (reason) => {
      const journal = new Journal(journalPath());
      try {
        journal.append({ event: 'readability.refused', actor: 'queue', reason } as never);
      } finally {
        journal.close();
      }
    }),
    prSnapshot: queuePrSnapshot(),
    // BBZ, 2026-09-08: read fresh every tick (`autoMergeAllowed` re-reads
    // `FORGE_COUNCIL_AUTOMERGE` off `councilPolicy()` on each call), the same allow-list
    // `forge gate --merge` already refuses against for a person -- this is the queue's
    // own worker asking for the identical decision instead of waiting on a click.
    mergeAllowed: (repo) => autoMergeAllowed(repo),
    postMergeVerify: queuePostMergeVerify(chainEnv),
    prMerged: async (repo, pr) => {
      const result = await execRun({
        argv: ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'mergedAt'],
        cwd: process.cwd(), owner: 'queue', cls: 'script', fullOutput: true, raw: true,
      });
      if (!result.ok) throw new Error('gh could not read the PR');
      return Boolean((JSON.parse(result.full ?? result.tail) as { mergedAt?: string | null }).mergedAt);
    },
    // Item 1 (2026-09-11): ONE `gh pr view --json statusCheckRollup`, never `REAL_GH.viewPr`
    // -- that reader also downloads the whole `gh pr diff`, so wiring this to it spent two
    // GitHub calls and a full diff per parked item per tick, against a rate limit every
    // session on this machine shares. A throw is an unreadable sensor, never a green
    // check, so it answers undefined and the recovery pass holds the item.
    checksConclusion: async (repo, pr) => {
      try {
        const result = await execRun({
          argv: ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'statusCheckRollup'],
          cwd: process.cwd(), owner: 'queue', cls: 'script', fullOutput: true, raw: true,
        });
        if (!result.ok) return undefined;
        const parsed = JSON.parse(result.full ?? result.tail) as { statusCheckRollup?: Parameters<typeof conclusionOf>[0] };
        return conclusionOf(parsed.statusCheckRollup);
      } catch {
        return undefined;
      }
    },
    // Items 1 and 2: the registry row's pid, and only when that process is actually
    // alive. `hasRunRegistered` is not this question -- it answers "did this run ever
    // start", which stays true for a run that died an hour ago.
    runPid: (runKey) => {
      const row = new Registry(registryDir()).get(runKey);
      return row && processAlive(row.pid) ? row.pid : undefined;
    },
  };
}

// Re-exported so `cli.ts` never needs its own import of `ForgeDeps`/`CliResult` just to
// satisfy this file's own type signature above.
export type { CliResult, ForgeDeps };
