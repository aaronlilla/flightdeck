/**
 * The intake queue: how work gets INTO Forge rather than only supervised once it is
 * already running. Four sources feed it -- a Jira ticket key, a pasted brief, a JQL query
 * naming a sprint or epic, and the backlog with an operator's own filter -- and the
 * worker in `runQueueTick` drives each item through the same shape `chain.ts` already
 * proved for a poll-sourced packet: plan, provision, launch, gate. Whether `advanceItem`
 * calls `deps.gate` with `merge: true` is `deps.mergeAllowed`'s own answer for the item's
 * repo -- the same `FORGE_COUNCIL_AUTOMERGE` allow-list `forge gate --merge` already
 * checks for a person (`council/risk.ts#autoMergeAllowed`). A repo absent from that list
 * (every one of them, until an operator opts a repo in) still stops at `review` with a
 * draft PR exactly as before this existed.
 *
 * Every dependency here is a function this module is handed, the same separation
 * `chain.ts` keeps from `chain-wire.ts`: nothing in this file touches the network,
 * spawns a process, or reads `~/.forge` itself. `queue-wire.ts` is where a real Jira
 * search, a real planner and the real `chainLauncher`/`chainGh`/`chainCouncil`/`chainGate`
 * get wired together; every specimen in this stream builds its own `QueueRuntimeDeps`
 * from plain functions instead.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { ChainCouncilFn, ChainGateFn, ChainGh, ChainLauncher, ChainProvisionResult } from '../chain.js';
import { runKeyForBrief } from '../chain.js';
import type { QueueItem, QueueItemState, QueueSource } from '../../shared/console-model.js';
import { branchFor } from '../chain-env.js';
import { evaluateAction } from '../rules/index.js';
import { renderNotes } from '../council/renderNotes.js';
import { terminalStateFor, type RepoKind } from './handoff.js';
import { parseAfterLines, repoFromBrief, roadmapFromBrief } from './repoRoute.js';
import type { QueueStore } from './queueStore.js';
import { workspaceRoot } from '../paths.js';
import { roadmapIdOpen } from '../roadmap.js';

/**
 * A.1: `ChainCouncilResult` (`chain.ts`) carries no findings text, only a verdict and an
 * optional coverage note -- there was never a caller before this one that needed to
 * reread a FIX FIRST round's own claims. `findingsText` is optional, so every existing
 * `ChainCouncilFn` (the chain's own, wired in `chain-wire.ts`) is still a valid
 * `QueueCouncilFn` unchanged; only a caller that actually supplies the field (this
 * stream's own wiring, once it exists) gets a real fix-round brief instead of the bare
 * word "FIX FIRST".
 */
export type QueueCouncilResult = Awaited<ReturnType<ChainCouncilFn>> & { findingsText?: string };
export type QueueCouncilFn = (input: Parameters<ChainCouncilFn>[0]) => Promise<QueueCouncilResult>;

export const QUEUE_IN_FLIGHT_STATES: readonly QueueItemState[] = ['planning', 'running'];

/** BBZ-60/62/74/202, 2026-09-08: the number of consecutive ticks `advanceItem` retries a
 *  gate hop whose checks came back pending before giving up and parking. Four real
 *  tickets sat at this hop with checks that all went green within a few minutes, so this
 *  is sized generously against the queue's own tick cadence rather than against how long
 *  a check can legitimately run -- it exists only to stop a check that never finishes
 *  (a hung runner, a workflow nobody canceled) from holding an item forever, not to bound
 *  ordinary CI time. */
export const PENDING_CHECKS_POLL_CAP = 20;

/** Item 1 (2026-09-11): how many times the tick may HAND ONE ITEM BACK to the worker
 *  before leaving it to a person for good. An item that parks, recovers and parks again
 *  three times is not having a bad minute; something about it needs reading.
 *
 *  Counting successful recoveries only, never "not yet" readings: the tick runs every
 *  `FORGE_QUEUE_POLL_S` seconds (default 15), so a budget spent on holds would be 45
 *  seconds of wall clock, and a worker outliving its own retry click by a minute would
 *  lose that retry for good -- the opposite of what item 2 promises. Holds are unbounded
 *  and cost one journal row per DISTINCT reading instead. */
export const PARK_RECOVERY_CAP = 3;

/** How long the recovery pass waits before asking GitHub about one item's checks again,
 *  and how many times it may ask at all.
 *
 *  Re-reading checks is a network call against a rate limit every session on this machine
 *  shares. Holds are unbounded by design (item 2 needs an item to keep its retry however
 *  long the worker outlives the click), so without these two the tick would spend a call
 *  per parked item every 15 seconds forever -- and would reinstate exactly the endless
 *  polling `PENDING_CHECKS_POLL_CAP` exists to stop. Reading the pid of a local process
 *  costs nothing and is deliberately left unbounded. */
export const PARK_CHECKS_RECHECK_MS = 5 * 60_000;
export const PARK_CHECKS_RECHECK_CAP = 20;

/** What re-reading would have to say before a parked item may move again. `checks` means
 *  the park is about a pull request's checks; `run` means it is about a worker process
 *  that may or may not still be alive. */
export type ParkRecheck = 'checks' | 'run';

export type ParkRecoverability =
  | { recoverable: true; reRead: ParkRecheck }
  | { recoverable: false; why: string };

/**
 * Item 1: whether a machine can decide this park on its own, read from the reason
 * `advanceItem` wrote. Fail-closed by construction -- a reason this function does not
 * recognise is NOT recoverable, so a new park reason added elsewhere never silently
 * starts auto-recovering before anybody has thought about it.
 */
export function parkRecoverability(reason: string | null | undefined): ParkRecoverability {
  const text = (reason ?? '').trim();
  if (!text) return { recoverable: false, why: 'the park carries no reason to re-read' };
  if (/^conflicts with /i.test(text)) {
    return { recoverable: false, why: 'a merge conflict is a person\'s call, not a stale reading' };
  }
  if (/^unrouted$/i.test(text)) return { recoverable: false, why: 'nothing routed the ticket to a repository' };
  if (/^backend:/i.test(text)) return { recoverable: false, why: 'the ticket was handed to the backend' };
  if (/^overlaps /i.test(text)) return { recoverable: false, why: 'another item holds the same files' };
  if (/checks (never settled|are pending)/i.test(text)) return { recoverable: true, reRead: 'checks' };
  // Every run verdict `relaunchOnRetryOrPark` passes through (`stopped`, `exhausted`,
  // `parked`, `unknown`) plus the launcher's own stale-liveness refusal: all of them are
  // about a process, and all of them are answered by asking whether one is still alive.
  // `exhausted` is deliberately absent: a run that hit its budget ceiling did not fail
  // on a stale reading, and relaunching it three more times only proves the ceiling again.
  if (/^exhausted$/i.test(text)) return { recoverable: false, why: 'the run spent its budget ceiling' };
  // `unverified` is the commonest of these: `worker.ts` writes it for a run that stopped
  // without finishing, and `advanceItem` parks on it twice. `failed` is deliberately
  // absent -- no writer emits it as a verdict, and a rule nothing produces is noise.
  if (/^(stopped|parked|unknown|unverified)$/i.test(text)) return { recoverable: true, reRead: 'run' };
  // The literal `advanceItem`'s gate hop writes when a finished run left no PR anywhere.
  // This is the commonest park of all, and the first cut of this table missed it.
  if (/no PR was found/i.test(text)) return { recoverable: true, reRead: 'run' };
  if (/produced no event|has a registry row|no run on the board/i.test(text)) return { recoverable: true, reRead: 'run' };
  // Item 2's own refusal: the retry is still wanted, the process was simply still alive.
  // Re-reading liveness is exactly what decides it, so it recovers on the same path.
  if (/^retry refused:/i.test(text)) return { recoverable: true, reRead: 'run' };
  return { recoverable: false, why: `no rule covers the park reason "${text}"` };
}

// ---------------------------------------------------------------------------------------
// Adding work
// ---------------------------------------------------------------------------------------

function newItemId(): string {
  return `Q-${randomUUID().slice(0, 8)}`;
}

function blankItem(
  id: string, source: QueueSource, input: string, ticket: string | null, at: number,
  roadmap: string | null = null,
): QueueItem {
  const after = parseAfterLines(input);
  return {
    id, source, input, ticket, repo: null, briefPath: null, branch: null, worktreePath: null, base: null,
    state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: at, updatedAt: at,
    ...(after.length ? { after } : {}),
    ...(roadmap ? { roadmap } : {}),
  };
}

/** Every ticket key a JQL query currently matches. `ticket`-sourced items never call
 *  this; `query` and `backlog` both resolve through it before a queue item exists for
 *  either. */
export interface QueueTicketSearch {
  searchKeys(jql: string): Promise<string[]>;
}

/** What one queue item resolves to, once planned: a routed repository and a brief file
 *  on disk. `repo: 'unknown'` (nothing routed the ticket) is a normal answer, not a
 *  thrown error -- `advanceItem` parks the item and reports it, the same as an unrouted
 *  packet in `chain.ts`. */
export interface QueuePlannedBrief {
  ticket: string;
  repo: string;
  briefPath: string;
}

/** R-76: the planning hop is an interview before it is a brief, so it has two outcomes
 *  besides a planned brief. `waiting` means the item asked a person something and is
 *  holding at `planning` until it is answered -- one item held, never the queue.
 *  `backend` means the ticket belongs to the backend and no worker should ever launch on
 *  it. A planner that knows about neither still satisfies this union unchanged. */
export type QueuePlanWaiting = { waiting: 'interview'; asks: number };
export type QueuePlanBackend = { backend: true; ticket: string; ask: string };
export type QueuePlanOutcome = QueuePlannedBrief | QueuePlanWaiting | QueuePlanBackend;

/** The reason an item held on an interview answer carries. One string, read in two
 *  places (the hop that writes it and the tick that excludes it from the width), so it
 *  is named rather than spelled twice. */
export const INTERVIEW_WAIT_REASON = 'interview';

/** True while this item is parked on a person's answer rather than doing work. */
export function isWaitingOnInterview(item: QueueItem): boolean {
  return item.state === 'planning' && item.reason === INTERVIEW_WAIT_REASON;
}

export function isPlanWaiting(outcome: QueuePlanOutcome): outcome is QueuePlanWaiting {
  return 'waiting' in outcome;
}

export function isPlanBackend(outcome: QueuePlanOutcome): outcome is QueuePlanBackend {
  return 'backend' in outcome;
}

export interface QueuePlanner {
  /** `itemId` is this queue item's own id (`Q-xxxxxxxx`), folded into the brief file's
   *  name alongside the ticket. A re-queued ticket, a fresh item added after an earlier
   *  one for the same ticket was removed, needs its own brief file and its own run key.
   *  Without `itemId`, `runOutcome` (`chain-wire.ts`) folds the new run onto the old
   *  one's terminal journal state, as happened at 13:35 on 2026-09-08: BBZ-233's new
   *  item Q-2181b071 read the removed item Q-0fff83b0's `parked` verdict as its own. */
  planTicket(ticket: string, itemId: string): Promise<QueuePlanOutcome>;
  /** A pasted brief carries no ticket of its own; the planner mints one (or the caller
   *  passes the queue item's own id) so the rest of the pipeline has something to name
   *  the branch and the run after. */
  planBrief(text: string): Promise<QueuePlannedBrief>;
  /** A.6: a typed hotfix, same shape as a pasted brief (no Jira ticket, the planner
   *  mints one) -- kept a separate method so the minted ticket can carry a marker
   *  (`chain-env.ts#branchFor`'s own `hotfix-` prefix check) that routes it onto
   *  `hotfix/<slug>` instead of `feature/<ticket>`. Absent falls back to `planBrief`,
   *  which still queues the item, just onto an ordinary feature branch. */
  planHotfix?(text: string): Promise<QueuePlannedBrief>;
}

export function addTicketItem(store: QueueStore, ticket: string, now: number = Date.now()): QueueItem {
  const item = blankItem(newItemId(), 'ticket', ticket, ticket, now);
  store.append({ ...item, at: now });
  return item;
}

/** R-02 guard #1: when `guard` is supplied and the brief's own `repo:` line names the
 *  self repo, the brief must carry a `roadmap: R-nn` line naming a row that is still
 *  open in `doctrine/ROADMAP.md` -- otherwise this throws, and the caller (`queue-route.ts`)
 *  turns that into the ordinary `{ ok: false, error }` refusal every other add failure
 *  already gets. A brief for any other repo, or a caller with no `guard` wired at all,
 *  is unaffected: the roadmap id is still recorded on the item when the brief happens to
 *  carry one, just never required. */
export function addBriefItem(
  store: QueueStore, briefText: string, now: number = Date.now(),
  guard?: { selfRepo: string; roadmapText: string },
): QueueItem {
  const roadmapId = roadmapFromBrief(briefText);
  if (guard && guard.selfRepo && repoFromBrief(briefText) === guard.selfRepo) {
    if (!roadmapId) {
      throw new Error(`brief for ${guard.selfRepo} is missing a "roadmap: R-nn" line`);
    }
    if (!roadmapIdOpen(guard.roadmapText, roadmapId)) {
      throw new Error(`brief names unknown or already-done roadmap id ${roadmapId}`);
    }
  }
  const item = blankItem(newItemId(), 'brief', briefText, null, now, roadmapId);
  store.append({ ...item, at: now });
  return item;
}

/** A.6: a typed hotfix -- no Jira ticket, same "queued with no ticket yet" shape as a
 *  pasted brief. `advanceItem` routes it through `QueuePlanner.planHotfix` instead of
 *  `planBrief`, which is the whole difference: the base and branch this item lands on. */
export function addHotfixItem(store: QueueStore, text: string, now: number = Date.now()): QueueItem {
  const item = blankItem(newItemId(), 'hotfix', text, null, now);
  store.append({ ...item, at: now });
  return item;
}

/** 2026-09-08: a goal file (a brief under `.claude/goals/` with a sibling
 *  `.block.txt`, or an exported task carrying a fenced ```goal-spec block) queued
 *  with its `/goal` condition already resolved (`goalFile.ts#resolveGoalBlock`,
 *  called by the caller before this, never by `advanceItem` itself -- a long-running
 *  item launches on the block it was queued with, not a re-read that could have
 *  changed under it). `briefPath` is set up front, same value as `input`: a goal item
 *  never goes through the planner, and `advanceItem`'s own `!item.briefPath` check is
 *  what tells the two sources apart. */
export function addGoalItem(store: QueueStore, goalPath: string, block: string, now: number = Date.now()): QueueItem {
  const item: QueueItem = { ...blankItem(newItemId(), 'goal', goalPath, null, now), briefPath: goalPath, goalBlock: block };
  store.append({ ...item, at: now });
  return item;
}

/** Backing for both `query` (a JQL string naming a sprint or epic) and `backlog` (an
 *  operator's own filter text, joined onto a project's backlog JQL by the caller before
 *  it reaches here) -- the two sources this module cannot tell apart once the search has
 *  already run. One queue item per matching ticket key. */
async function addResolvedTickets(
  store: QueueStore, source: 'query' | 'backlog', input: string, search: QueueTicketSearch, now: number,
): Promise<QueueItem[]> {
  const keys = await search.searchKeys(input);
  return keys.map((key) => {
    const item = blankItem(newItemId(), source, input, key, now);
    store.append({ ...item, at: now });
    return item;
  });
}

export function addQueryItems(
  store: QueueStore, jql: string, search: QueueTicketSearch, now: number = Date.now(),
): Promise<QueueItem[]> {
  return addResolvedTickets(store, 'query', jql, search, now);
}

export function addBacklogItems(
  store: QueueStore, filter: string, search: QueueTicketSearch, now: number = Date.now(),
): Promise<QueueItem[]> {
  return addResolvedTickets(store, 'backlog', filter, search, now);
}

// ---------------------------------------------------------------------------------------
// Removing, retrying, pausing
// ---------------------------------------------------------------------------------------

export function removeItem(store: QueueStore, id: string, now: number = Date.now()): boolean {
  if (!store.get(id)) return false;
  store.append({ id, at: now, removedAt: now, updatedAt: now });
  return true;
}

/** Sends a `parked` or `failed` item back to a working state, keeping whatever it
 *  already planned (ticket, repo, brief, runKey) -- a retry re-runs the hop that stopped
 *  it, never the whole item from scratch. Refuses on any other state: a
 *  `queued`/`planning`/`running` item is not stuck, and a `review`/`done` item already
 *  reached the end of what this queue does for it.
 *
 *  The state it lands on depends on how far the item had already gotten. `runKey` already
 *  set means a run exists and this item is re-entering `advanceItem`'s status/gate hop,
 *  not its plan/launch hop -- that is `running`, one of `QUEUE_IN_FLIGHT_STATES`, or
 *  `runQueueTick` cannot tell this item apart from one nobody has touched yet. Confirmed
 *  live 2026-09-06: landing every retry on `queued` regardless left a run mid-flight
 *  invisible to that in-flight check, so the next tick (and the one after, since nothing
 *  here waits for the last tick's advance to finish) added the same item back onto its
 *  advance list on top of the pass already running -- a second full council/gate round,
 *  a second real Codex subprocess, for the one item. No `runKey` yet means the item never
 *  got past planning or launch, and `queued` is correct: there is nothing in flight for a
 *  concurrent tick to collide with. */
export function retryItem(store: QueueStore, id: string, now: number = Date.now()): QueueItem | undefined {
  const item = store.get(id);
  if (!item || (item.state !== 'parked' && item.state !== 'failed')) return undefined;
  const state: QueueItemState = item.runKey ? 'running' : 'queued';
  // B: `retriedAt` only matters when a runKey already exists -- `advanceItem` reads it to
  // tell a retry of a run that finished with no PR apart from the ordinary first read of
  // that same status, so the retry can clear the stale runKey and launch again instead of
  // reporting the same old verdict back to a person a second time.
  const patch: Partial<QueueItem> = { state, reason: null, updatedAt: now, ...(item.runKey ? { retriedAt: now } : {}) };
  store.append({ id, at: now, ...patch });
  return { ...item, ...patch };
}

// ---------------------------------------------------------------------------------------
// The worker: advancing what is already in the queue
// ---------------------------------------------------------------------------------------

/** A minimal journal event handed back to `advanceItem` -- everything this module needs
 *  from `Journal.append`/`appendOnce`'s real `ForgeEvent`. */
export interface QueueJournalWrite {
  id: string;
}

/** What `rebaseOnBase` answers. `behind` says how far the branch had drifted, so a run
 *  that needed no replay can be told apart from one that did. */
export interface RebaseOutcome {
  ok: boolean;
  behind: number;
  reason?: string;
  /** Files the worker left modified or untracked in its worktree that the rebase
   *  committed on its own branch before replaying, so a dirty tree never parks an
   *  otherwise-finished item. Absent (or empty) means the tree was already clean. */
  committedLeftover?: string[];
}

export interface QueueRuntimeDeps {
  planner: QueuePlanner;
  launcher: ChainLauncher;
  gh: ChainGh;
  /** Brings the branch up to date with its base before the gate reads it, and answers
   *  whether that succeeded. A branch that has fallen behind while the work ran is the
   *  ordinary case on a busy repository; one that cannot be replayed cleanly is a real
   *  conflict, and the item parks for a person rather than anything being forced. */
  rebaseOnBase?: (input: { worktreePath: string; base: string }) => Promise<RebaseOutcome>;
  council: QueueCouncilFn;
  /** A.1: relaunches the worker on the item's own worktree with the round's findings as
   *  its brief -- one fix round, never a from-scratch replan. Absent means this
   *  environment never wires a fix round; a FIX FIRST then always parks, the behaviour
   *  every specimen before this stream already proved. */
  relaunchForFixRound?: (input: { item: QueueItem; findings: string }) => Promise<{ runKey: string }>;
  /** A.2: posts the council's own notes on the PR before the item reaches `review`.
   *  Best effort -- a comment failing never blocks the item; absent means this
   *  environment never wires the write, and no comment is attempted. */
  commentOnPr?: (input: { repo: string; pr: number; body: string }) => Promise<void>;
  /** A.4: which side of `handoff.ts#terminalStateFor` an item's routed repository is on.
   *  Absent means every item is treated as frontend -- the terminal state every specimen
   *  before this stream already assumed. */
  repoKindFor?: (repo: string) => RepoKind;
  /** A.4: the backend ping itself -- a Jira assign to the backend owner and a PR
   *  reviewer request, run only for a `terminalStateFor('backend')` item at `review`.
   *  Best effort, the same as the review comment: a failed ping never blocks review,
   *  since the controlled-code merge denial (`rules/gitflow.ts`) is what actually keeps
   *  the repo safe, not this notification. */
  backendHandoff?: (input: { item: QueueItem; pr: { no: number } }) => Promise<void>;
  /** A.3: the Jira write-back at review -- a comment, a QA assign, a QA transition and
   *  a remote link, all in Aaron's voice. Runs once per item, guarded by `handoffAt`;
   *  absent means this environment never wires it, and no Jira write happens at all. */
  jiraHandoff?: (input: { item: QueueItem; pr: { no: number; url: string } }) => Promise<void>;
  /** A.8/A.9: the PR's own changed files and line counts. Fetched once per item, right
   *  after the PR is found and before the council reads it, so A.9's overlap check runs
   *  against real data and A.8's figures at `review` need no second fetch. Absent means
   *  this environment never wires it -- an item then carries no changed-files list, the
   *  overlap check never fires, and `review`'s figures stay the honest zeros they always
   *  were. */
  prSnapshot?: (repo: string, pr: number) => Promise<{ files: string[]; add: number; del: number }>;
  /** Whether a PR has merged, by whoever merged it. A review item whose PR merged by
   *  hand (the CLI gate, GitHub itself) lands on `done` on the next sweep instead of
   *  sitting in review with a Merge button forever (seen live 2026-09-07). */
  prMerged?: (repo: string, pr: number) => Promise<boolean>;
  /** Item 1 (2026-09-11): the PR's current check conclusion, re-read when deciding
   *  whether a park about checks has cleared. Undefined answers, and an absent
   *  dependency, both read as "not green" -- this never guesses a check passed. */
  checksConclusion?: (repo: string, pr: number) => Promise<string | undefined>;
  /** Items 1 and 2 (2026-09-11): the live pid behind a run key, or undefined when no
   *  process is alive for it. The registry's own liveness check (`registry.ts`
   *  `processAlive`), handed in rather than read here so this file still spawns nothing.
   *  Absent means this environment cannot tell, and the relaunch guard stands down --
   *  the behaviour every caller had before the guard existed. */
  runPid?: (runKey: string) => number | undefined;
  /** Reused from `chain.ts` unchanged. Whether `advanceItem` passes `merge: true` is
   *  this file's own decision (see `mergeAllowed` below), not whatever the caller wires
   *  this to. */
  gate: ChainGateFn;
  /** BBZ, 2026-09-08: whether an item's repo may merge the moment its gate clears, with
   *  no click -- the same allow-list decision `council/risk.ts#autoMergeAllowed` makes
   *  for a human running `forge gate --merge` (backed by `FORGE_COUNCIL_AUTOMERGE`),
   *  read fresh every tick so an operator's env change takes effect on the next one.
   *  Absent means every item still stops at a draft PR, the only behaviour every
   *  specimen before this stream ever proved. */
  mergeAllowed?: (repo: string) => boolean;
  /** Same shape as `QueueMergeDeps.postMergeVerify`, wired here so an item this file
   *  merges on its own gets the identical OTA verification a person's Merge click
   *  already gets. Absent means an auto-merged item lands on `done` with no OTA line,
   *  the same fallback `mergeItem` already has. */
  postMergeVerify?: (input: { repo: string; branch: string; mergeSha?: string }) => Promise<{ android: string; ios: string } | undefined>;
  /** 2026-09-08: launches a `goal` item -- its own worktree, its own gates, no brief
   *  file to plan or amend. Absent means a goal item always fails at the launch hop;
   *  every other source ignores this. */
  launchGoal?: (input: { goalPath: string; block: string; cwd: string; runKey: string }) => Promise<{ runKey: string }>;
  /** Whether feature/<branch> is already merged into origin/main on the repo's checkout.
   *  Backs an after: <slug> entry that names no queue item. Absent means such an entry
   *  never resolves. */
  branchMerged?: (repo: string, branch: string) => Promise<boolean>;
  /** Every repository this environment has a checkout for (`ChainEnv.checkouts`, wired
   *  from `FORGE_REPO_CHECKOUTS` in `buildQueueRuntimeDeps`) -- the fallback list
   *  `unresolvedAfterReason` asks `branchMerged` about when an `after: <slug>` entry
   *  names no queue item and the gated item's own `repo` isn't known yet. `item.repo`
   *  is `null` for the entire time a real item sits `queued` (`blankItem` sets it, and
   *  `advanceItem` only fills it in once the item is planned, which happens after this
   *  gate runs), so gating on `item.repo` alone made the merged-branch fallback dead
   *  code for every item added through the ordinary add path. Absent or empty means no
   *  fallback repo is known, the same "never resolves" answer as before this field
   *  existed. */
  mergeCheckRepos?: string[];
  clock(): number;
  killSwitch(): boolean;
  paused(): boolean;
  /** Read fresh on every tick, same as `paused` and `killSwitch` above -- a live
   *  `POST /queue/width` takes effect on the next tick, never only at process start. */
  maxInFlight(): number;
  /** Writes one row to the fleet journal, returning it -- so the item can carry the
   *  jid forward the same way every other Forge write does. */
  append(event: Record<string, unknown>): QueueJournalWrite;
  store: QueueStore;
}

export interface QueueTickResult {
  started: number;
  advanced: number;
  killSwitchEngaged: boolean;
  paused: boolean;
}

function tailOf(message: string, limit = 500): string {
  return message.length > limit ? message.slice(-limit) : message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pulls the run key a registry admission refusal already named as live, out of the
 *  free-text reason `Registry.admit` (`registry.ts`) produces for a launch that lost a
 *  race to a run already holding the same worktree or the same goal name. Returns
 *  `undefined` for any other launch failure (a `git worktree add` failure, a failed
 *  `npm ci`), which still fails the item exactly as before this function existed. */
function liveRunKeyFrom(message: string): string | undefined {
  const cwdCollision = /already has a live run \(goal ([^,]+), pid \d+\)/.exec(message);
  if (cwdCollision) return cwdCollision[1];
  const selfCollision = /\bgoal (\S+) already has a live run \(pid \d+\)/.exec(message);
  return selfCollision?.[1];
}

function prFromUrl(url: string): { number: number; url: string } | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? { number: Number(match[1]), url } : undefined;
}

/** Writes one item transition: a `queue.*` row on the fleet journal (the shared audit
 *  trail every other Forge write already uses) and the matching row in the queue's own
 *  log, then returns the item with both applied. Every hop in `advanceItem` goes through
 *  this, so an item's `journalIds` always lines up with what `GET /journal` shows for it. */
function writeTransition(
  item: QueueItem, patch: Partial<QueueItem>, deps: QueueRuntimeDeps, event: string,
  extra: Record<string, unknown> = {},
): QueueItem {
  const written = deps.append({ event, actor: 'queue', itemId: item.id, ...extra });
  const now = deps.clock();
  const journalIds = written.id ? [...item.journalIds, written.id] : item.journalIds;
  const next: QueueItem = { ...item, ...patch, journalIds, updatedAt: now };
  deps.store.append({ id: item.id, at: now, ...patch, journalIds, updatedAt: now });
  return next;
}

/** B: the "finished but no PR anywhere" outcome parks an item on any ordinary first
 *  read, but a retry (`item.retriedAt` set by `retryItem`) means an operator already
 *  asked for this run to be looked at again, and `deps.launcher.status` is answering
 *  with the same stale verdict as before -- seen live at 13:25, 13:28 and 13:35 on
 *  2026-09-08 (BBZ-233, items Q-0fff83b0 and Q-2181b071), parking again within seconds
 *  of the retry click. So a retry clears `runKey` and the marker together, journals the
 *  relaunch, and re-enters `advanceItem` at once -- which lands on the launch hop
 *  (`!item.runKey`) and provisions a fresh run on the same worktree and branch. An item
 *  with no `retriedAt` still parks exactly as before. */
async function relaunchOnRetryOrPark(
  item: QueueItem, deps: QueueRuntimeDeps, reason: string, extra: Record<string, unknown>,
): Promise<QueueItem> {
  if (item.retriedAt) {
    // Item 2 (2026-09-11): the relaunch below clears `runKey` and provisions a fresh run
    // on the SAME worktree. Doing that while the first worker's process is still alive
    // puts two agents on one working tree; it happened live on 2026-09-11 and cost eight
    // minutes of a worker's uncommitted work. The retry is not thrown away -- the marker
    // stays set, so the next tick tries again once the process is gone.
    const pid = item.runKey ? deps.runPid?.(item.runKey) : undefined;
    if (pid !== undefined) {
      return writeTransition(
        item, { state: 'parked', reason: `retry refused: ${item.runKey} is still running as pid ${pid}` },
        deps, 'queue.relaunch-refused', { runKey: item.runKey, pid },
      );
    }
    const relaunching = writeTransition(
      item, { runKey: null, retriedAt: null }, deps, 'queue.relaunch-on-retry',
      { previousRunKey: item.runKey, parkReason: reason },
    );
    return advanceItem(relaunching, deps);
  }
  return writeTransition(item, { state: 'parked', reason }, deps, 'queue.parked', extra);
}

/** Whole-slug match only: `after: BBZ-20` names BBZ-20, never BBZ-205. A slug matches an
 *  item whose `input`, brief file name (with or without the `queue-` prefix and `.md`),
 *  or branch (bare, or as `branchFor(slug)`) is that slug exactly, case-insensitively. */
export function slugMatches(candidate: QueueItem, slug: string): boolean {
  const lower = slug.toLowerCase();
  const names = new Set<string>();
  if (candidate.input) names.add(candidate.input.toLowerCase());
  if (candidate.ticket) names.add(candidate.ticket.toLowerCase());
  if (candidate.briefPath) {
    const file = basename(candidate.briefPath).toLowerCase().replace(/\.md$/, '');
    names.add(file);
    if (file.startsWith('queue-')) names.add(file.slice('queue-'.length));
  }
  if (candidate.branch) {
    const branch = candidate.branch.toLowerCase();
    names.add(branch);
    names.add(branch.replace(/^(feature|hotfix)\//, ''));
  }
  return names.has(lower) || names.has(branchFor(slug).toLowerCase());
}

/** Whether every after: entry on item has resolved: an item in state 'done', or (when no
 *  queue item matches the slug) deps.branchMerged reporting that the branch already merged.
 *  Returns the reason to hold the item on when it has not resolved, or null when it is clear
 *  to start. The two reason shapes are deliberately different: a matched but not-done
 *  predecessor reads "waiting on <slug>", an unmatched one reads "waiting on unknown item:
 *  <slug>", and the queue view renders the two differently. */
/** Which repository or repositories `unresolvedAfterReason` should ask `branchMerged`
 *  about for one unmatched `after: <slug>` entry. `item.repo` wins once it is known
 *  (an item already planned), but a queued item's own `repo` is null the entire time
 *  this gate runs -- `blankItem` sets it, and `advanceItem` only fills it in once the
 *  item leaves `queued`, which happens after this check -- so the fallback list this
 *  environment has a checkout for (`deps.mergeCheckRepos`) is what a real, never-yet-
 *  planned item actually resolves against. */
async function mergedOnKnownRepo(item: QueueItem, slug: string, deps: QueueRuntimeDeps): Promise<boolean> {
  if (!deps.branchMerged) return false;
  const branch = branchFor(slug);
  const repos = item.repo ? [item.repo] : (deps.mergeCheckRepos ?? []);
  for (const repo of repos) {
    if (await deps.branchMerged(repo, branch)) return true;
  }
  return false;
}

async function unresolvedAfterReason(
  item: QueueItem, items: QueueItem[], deps: QueueRuntimeDeps,
): Promise<string | null> {
  for (const slug of item.after ?? []) {
    const matches = items.filter((other) => other.id !== item.id && slugMatches(other, slug));
    if (matches.length > 0) {
      if (matches.every((m) => m.state === 'done')) continue;
      return `waiting on ${slug}`;
    }
    if (await mergedOnKnownRepo(item, slug, deps)) continue;
    return `waiting on unknown item: ${slug}`;
  }
  return null;
}

/**
 * One item, one hop forward. Mirrors `chain.ts`'s `advancePacket`: plan if there is no
 * brief yet, provision and launch if there is no run yet, then wait for the run and gate
 * it once it finishes. Every hop that fails outright (planning, provisioning or launch
 * throwing) lands the item on `failed`; every hop that finishes but does not clear (an
 * unrouted repo, a non-`done` verdict, a council that did not pass, a finished run with
 * no PR anywhere) lands it on `parked` -- always a person's call, never retried on its
 * own. Called for an item already `planning` or `running` too, so a crash between two
 * hops picks up exactly where it stopped rather than repeating work already done.
 */
export async function advanceItem(itemIn: QueueItem, deps: QueueRuntimeDeps): Promise<QueueItem> {
  let item = itemIn;

  // 2026-09-08: a `goal` item skips planning, provisioning, the council and the gate
  // entirely -- a goal brief already claimed its own worktree with `/workon` and
  // carries its own guardrails and acceptance criteria as its `/goal` condition, so
  // there is no repo to route, no brief to plan, and no draft PR for this file's own
  // council/gate hops to review. It only ever moves `queued` -> `running` -> a
  // terminal state the run's own verdict decides, never through `review`.
  if (item.source === 'goal') {
    if (!item.runKey) {
      if (!deps.launchGoal) {
        return writeTransition(
          item, { state: 'failed', reason: 'no launchGoal dependency wired for this environment' },
          deps, 'queue.failed', { hop: 'launch' },
        );
      }
      try {
        const goalPath = item.briefPath ?? item.input;
        // 2026-09-08 (run-key collision fix): unique per item, never the bare
        // basename `runKeyForBrief` alone gives -- re-adding the same goal file used
        // to reuse the previous run's key and directory, so the new launch's own
        // `waitForLaunchToRegister` read the OLD run as already registered.
        const runKey = `${runKeyForBrief(goalPath)}-${item.id}`;
        const launched = await deps.launchGoal({
          goalPath, block: item.goalBlock ?? '', cwd: workspaceRoot(), runKey,
        });
        return writeTransition(item, { runKey: launched.runKey, state: 'running' }, deps, 'queue.launched', { runKey: launched.runKey });
      } catch (error) {
        return writeTransition(item, { state: 'failed', reason: tailOf(messageOf(error)) }, deps, 'queue.failed', { hop: 'launch' });
      }
    }
    const status = await deps.launcher.status(item.runKey);
    if (!status.finished) return item;
    if (status.verdict === 'done') {
      return writeTransition(
        item, { state: 'done', reason: status.lastText ? `goal loop ended: ${status.lastText}` : 'goal loop ended' },
        deps, 'queue.done', {},
      );
    }
    // 2026-09-08: a goal item that finishes on anything other than `done`, most often
    // `exhausted` after a chain of context-ceiling handoffs used up its session budget,
    // parks exactly like a brief-source item does (`relaunchOnRetryOrPark`, shared with
    // the hop below) instead of failing outright. Live incident: Q-17bb4283 reached the
    // implement-class ceiling, handed off the way a brief does, and still landed on
    // `failed` with the bare word `parked` as its reason. A goal item has no gate hop of
    // its own to route a non-`done` verdict through, so this branch was the only one left
    // and it always failed. An operator's retry (`item.retriedAt`) still clears `runKey`
    // and relaunches on the same goal path via `launchGoal`, the same way a retried brief
    // relaunches via `launcher.launch`.
    return relaunchOnRetryOrPark(item, deps, status.verdict ?? 'unknown', { hop: 'run' });
  }

  if (!item.briefPath) {
    // Clears a stale after:-gate `reason` and `after` list the moment the item leaves
    // `queued` -- neither was ever patched past this point before, so a resolved item
    // carried a permanent "waiting on ..." line through planning, running and review
    // (`reason`/`after` in `console-model.ts`; the queue view reads both straight off
    // the item with no other staleness check).
    if (item.state !== 'planning') {
      item = writeTransition(item, { state: 'planning', reason: null, after: [] }, deps, 'queue.planning');
    }
    let planned: QueuePlanOutcome;
    try {
      planned = item.source === 'brief'
        ? await deps.planner.planBrief(item.input)
        : item.source === 'hotfix'
          ? await (deps.planner.planHotfix ?? deps.planner.planBrief)(item.input)
          : await deps.planner.planTicket(item.ticket ?? item.input, item.id);
    } catch (error) {
      return writeTransition(item, { state: 'failed', reason: tailOf(messageOf(error)) }, deps, 'queue.failed', { hop: 'plan' });
    }
    // R-76: the interview asked somebody something. The item HOLDS at `planning` rather
    // than parking -- `runQueueTick` advances only `planning`, `running` and `queued`, so
    // a parked item would wait for an operator's Retry click even after the answer
    // arrived. Every other item on this tick is untouched: one question holds one row.
    // The `queue.waiting` row is written once, on the tick the reason first changes, so
    // an item held for a day does not write a row a minute.
    if (isPlanWaiting(planned)) {
      const reason = INTERVIEW_WAIT_REASON;
      if (item.reason === reason) return item;
      return writeTransition(item, { reason }, deps, 'queue.waiting', { hop: 'plan', asks: planned.asks });
    }
    // R-76: the ticket is the backend's. `terminalStateFor('backend')` is the same
    // governance boundary the gate hop already reads -- a backend ticket stops at a draft
    // PR and pings its owner, never merges -- and reaching that conclusion at planning
    // means no worker should launch on it at all. It parks with the interviewer's own
    // sentence as its reason, which is correct here in a way it is not for a question: a
    // backend ticket is waiting on a person outside this queue, not on an answer that
    // wakes it.
    if (isPlanBackend(planned)) {
      const terminal = terminalStateFor('backend');
      return writeTransition(
        item, { ticket: planned.ticket, repo: 'backend', state: 'parked', reason: `backend: ${planned.ask}` },
        deps, 'queue.parked', { hop: 'plan', route: 'backend', pings: terminal.pings },
      );
    }
    const brief: QueuePlannedBrief = planned;
    if (brief.repo === 'unknown') {
      return writeTransition(
        item, { ticket: brief.ticket, briefPath: brief.briefPath, repo: brief.repo, state: 'parked', reason: 'unrouted' },
        deps, 'queue.parked', { hop: 'plan' },
      );
    }
    // Planned, not yet launched: returned rather than falling through, so provisioning
    // and launch happen on the tick that follows, one hop per call the same way
    // `chain.ts`'s own planning hop (`runChainTick`) never launches in the same pass
    // that wrote `intake.planned`.
    return writeTransition(
      // `reason: null` clears the interview's own "waiting on an answer" line the moment
      // the item stops waiting -- the same staleness the after-gate `reason` above had to
      // be taught to clear, and this hop is the only place it can happen, because an item
      // held at `planning` never re-enters `planning` and so never hits that clear.
      item, { ticket: brief.ticket, briefPath: brief.briefPath, repo: brief.repo, state: 'running', reason: null },
      deps, 'queue.planned', { repo: brief.repo },
    );
  }

  if (!item.runKey) {
    let provisioned: ChainProvisionResult | undefined;
    try {
      provisioned = await deps.launcher.provision({ packetId: item.id, ticket: item.ticket!, repo: item.repo! });
      const launched = await deps.launcher.launch({
        packetId: item.id, ticket: item.ticket!, repo: item.repo!, briefPath: item.briefPath!,
        worktreePath: provisioned.worktreePath, branch: provisioned.branch,
      });
      return writeTransition(
        item,
        { runKey: launched.runKey, branch: provisioned.branch, worktreePath: provisioned.worktreePath, base: provisioned.base },
        deps, 'queue.launched', { runKey: launched.runKey },
      );
    } catch (error) {
      const message = messageOf(error);
      // The worktree this item just tried to launch on already carries a live run --
      // failing the item here would orphan that run with nothing attached to it, which
      // is exactly what happened live on 2026-09-08 (BBZ-140 / Q-7a01a197: it went
      // `failed` on this catch while the run it collided with kept going unattended).
      // Attach to the run that won the race instead, and keep polling its status the
      // same way a launch that succeeded on the first try would.
      const liveRunKey = provisioned ? liveRunKeyFrom(message) : undefined;
      if (liveRunKey) {
        return writeTransition(
          item,
          { runKey: liveRunKey, state: 'running', branch: provisioned!.branch, worktreePath: provisioned!.worktreePath, base: provisioned!.base },
          deps, 'queue.duplicate-launch', { attemptedRunKey: runKeyForBrief(item.briefPath!), liveRunKey },
        );
      }
      return writeTransition(item, { state: 'failed', reason: tailOf(message) }, deps, 'queue.failed', { hop: 'launch' });
    }
  }

  const status = await deps.launcher.status(item.runKey);
  if (!status.finished) return item;

  // A run that ended `unverified` (its session finished without `forge_done`) may still
  // have pushed and opened its PR first -- seen live on 2026-09-07, where a successor
  // session answered its ask and then ended on empty turns with PR #119 already open.
  // The PR is the deliverable; the council and green checks are the referee. So an
  // unverified run whose branch carries a PR goes on to the gate, with the verdict
  // recorded, instead of parking on a state a person could not act on.
  let pr = status.prUrl ? prFromUrl(status.prUrl) : undefined;
  if (!pr && item.branch) pr = await deps.gh.findPrByHead(item.repo!, item.branch);
  if (status.verdict !== 'done') {
    // Same for a run that was parked, blocked or killed after its PR was up (a warden
    // trip on a slow build, an operator's kill of a session that would not end): the PR
    // is what the gate reviews, and the run's own verdict travels in the journal row.
    if (pr && status.verdict !== undefined) {
      deps.append({ event: 'queue.unverified-pr', actor: 'queue', itemId: item.id, pr: pr.number, url: pr.url, verdict: status.verdict });
    } else {
      return relaunchOnRetryOrPark(item, deps, status.verdict ?? 'unknown', { hop: 'gate' });
    }
  }
  if (!pr) {
    return relaunchOnRetryOrPark(
      item, deps, 'run finished done but no PR was found in its evidence or on its branch', { hop: 'gate' },
    );
  }

  // A.8/A.9: one fetch of the PR's own changed files and line counts, right after the PR
  // is found and before the council or the overlap check reads either -- shared by A.9's
  // overlap check below and A.8's real figures once the item reaches `review`, so this
  // never fetches the same PR's diff twice within one call.
  let prAdd: number | undefined;
  let prDel: number | undefined;
  if (deps.prSnapshot) {
    const snapshot = await deps.prSnapshot(item.repo!, pr.number);
    prAdd = snapshot.add;
    prDel = snapshot.del;
    item = writeTransition(item, { changedFiles: snapshot.files }, deps, 'queue.pr-files', {});

    // A.9, moved from stream B to keep this file single-owner: an item whose changed
    // files overlap another item already running or in review on the same repo parks
    // rather than reviewing a diff two workers are racing on. Only the later-created
    // item ever parks itself here -- the earlier one is left untouched, since by
    // construction it reached this check first and has nothing to answer for.
    const overlap = deps.store.all().find((other) => (
      other.id !== item.id && other.repo === item.repo
      && (other.state === 'running' || other.state === 'review')
      && other.changedFiles && other.changedFiles.some((file) => snapshot.files.includes(file))
      && other.createdAt <= item.createdAt
    ));
    if (overlap) {
      const shared = (overlap.changedFiles ?? []).filter((file) => snapshot.files.includes(file));
      return writeTransition(
        item,
        { state: 'parked', reason: `overlaps ${overlap.ticket ?? overlap.id} on ${shared.join(', ')}` },
        deps, 'queue.parked', { hop: 'overlap', with: overlap.id },
      );
    }
  }

  // Aaron, 2026-09-07: every branch must sit on the latest base before anyone reviews or
  // merges it, so a queue that runs for hours cannot hand back a pile of conflicts. The
  // replay happens here, after the work is done and before the gate reads the diff.
  if (deps.rebaseOnBase && item.worktreePath && item.base) {
    const replay = await deps.rebaseOnBase({ worktreePath: item.worktreePath, base: item.base });
    if (replay.committedLeftover?.length) {
      deps.append({
        event: 'queue.leftover-committed', actor: 'queue', itemId: item.id, files: replay.committedLeftover,
      });
      if (deps.commentOnPr) {
        const body = `The queue committed files the worker left uncommitted before rebasing onto \`${item.base}\`: ${
          replay.committedLeftover.map((file) => `\`${file}\``).join(', ')
        }.`;
        try {
          await deps.commentOnPr({ repo: item.repo!, pr: pr.number, body });
        } catch {
          // Best effort, same as the council-notes comment above -- a comment failing
          // never blocks the item, and the journal row already carries the file list.
        }
      }
    }
    if (!replay.ok) {
      return writeTransition(
        item,
        { state: 'parked', reason: `conflicts with ${item.base}: ${replay.reason ?? 'the branch could not be replayed on its base'}` },
        deps, 'queue.parked', { hop: 'gate', behind: replay.behind },
      );
    }
  }

  const council = await deps.council({
    repo: item.repo!, pr: pr.number, forceCodex: true,
    ...(item.worktreePath ? { cwd: item.worktreePath } : {}),
    // `origin/<base>`, never the bare branch name: the local ref is whatever this
    // machine last fetched, and reviewing against it puts everything merged since inside
    // this ticket's diff. Provisioning refreshes the remote ref, so this one is current.
    ...(item.base ? { baseRef: `origin/${item.base}` } : {}),
  });
  // BBZ-60/62/74/202, 2026-09-08: a pending check is "not yet", never "no" -- four real
  // items parked on `refused: checks are pending on head <sha>` and needed an operator to
  // merge them by hand once the same checks went green minutes later. Checked before
  // `councilCleared` below (which would otherwise read the pending placeholder verdict as
  // a plain non-pass and park it the same way a real failure does): leaving `state`
  // untouched keeps the item in `QUEUE_IN_FLIGHT_STATES`, so the next tick calls the
  // council again instead of leaving it stuck.
  if (council.pending) {
    const polls = (item.pendingGatePolls ?? 0) + 1;
    if (polls >= PENDING_CHECKS_POLL_CAP) {
      return writeTransition(
        item,
        { state: 'parked', reason: `checks never settled after ${PENDING_CHECKS_POLL_CAP} polls` },
        deps, 'queue.parked', { hop: 'gate' },
      );
    }
    return writeTransition(
      item, { pendingGatePolls: polls, reason: `checks are pending on head ${pr.number}, waiting to retry` },
      deps, 'queue.pending-checks', { hop: 'gate' },
    );
  }
  if (item.pendingGatePolls) {
    // The streak broke -- the next park (if any) should not read as a pending timeout.
    item = { ...item, pendingGatePolls: undefined };
  }

  const councilCleared = council.verdict === 'PASS' || council.verdict === 'PASS WITH NOTES';
  if (!councilCleared) {
    // A.1: a FIX FIRST on an item that has not already used its one fix round relaunches
    // the worker on the same worktree instead of parking outright -- the findings are a
    // fixable problem, not a question for a person, and asking a person for every one of
    // those defeats the point of the queue. Coverage-missing never gets a fix round: a
    // member that did not answer says nothing about whether the code has a problem, so
    // relaunching against it would be guessing at a "fix" for no claim at all.
    if (council.verdict === 'FIX FIRST' && !council.coverageNote && !item.fixRoundsUsed && deps.relaunchForFixRound) {
      const findings = council.findingsText
        ?? 'the council returned FIX FIRST with no findings text carried on this result';
      const relaunched = await deps.relaunchForFixRound({ item, findings });
      return writeTransition(
        item, { runKey: relaunched.runKey, fixRoundsUsed: 1 }, deps, 'queue.fix-round',
        { previousRunKey: item.runKey, findings },
      );
    }
    // GATE.md item 4: when the council itself named which members never answered, that
    // rides along on the parked reason -- a bare "FIX FIRST" tells nobody whether the
    // diff had a real problem or the round never got read.
    const reason = council.coverageNote
      ? `${council.verdict}: ${council.coverageNote}`
      : item.fixRoundsUsed
        ? `${council.verdict} after ${item.fixRoundsUsed} fix round(s), parking rather than relaunching again`
        : council.verdict;
    return writeTransition(item, { state: 'parked', reason }, deps, 'queue.parked', { hop: 'gate' });
  }

  // Merge only when this item's repo is on the operator's own autoMerge allow-list --
  // `deps.mergeAllowed` is the same decision `council/risk.ts#autoMergeAllowed` makes for
  // a human running `forge gate --merge`. Every other repo, including the controlled-code
  // management system, gets `merge: false` here exactly as before: unset `mergeAllowed`
  // reads as false, and so does a `mergeAllowed` that simply doesn't name this repo.
  const merge = deps.mergeAllowed?.(item.repo!) ?? false;
  const gateResult = await deps.gate({ repo: item.repo!, pr: pr.number, merge });

  // A.2: the council's own notes land on the PR before the item shows as `review`, so a
  // reviewer never has to go dig an attestation file out of `~/.forge` to see what was
  // found. Gated through `evaluateAction` (a `pr`/`comment` action is always allowed,
  // even on a controlled-code repo -- `rules/gitflow.ts`'s own carve-out) so the write
  // exercises the same rule every other Council write does. Best effort: a comment that
  // fails must never keep an otherwise-cleared item off `review`.
  if (deps.commentOnPr) {
    const verdict = evaluateAction({ kind: 'pr', op: 'comment', repo: item.repo!, cwd: '' });
    if (verdict.allow) {
      const body = renderNotes({ verdict: council.verdict, coverageNote: council.coverageNote, findingsText: council.findingsText });
      try {
        await deps.commentOnPr({ repo: item.repo!, pr: pr.number, body });
      } catch {
        // Best effort, per A.2: the comment is a courtesy, not a gate.
      }
    }
  }

  // A.4: a backend item ends at "draft PR open, backend owner pinged" -- restated here
  // as a call to `handoff.ts#terminalStateFor` rather than a scattered
  // `if (repo === ...)`, so which repos are backend stays this environment's own
  // `repoKindFor` wiring, never a name baked into this file (agnostic check).
  let handoffAt = item.handoffAt;
  if (deps.jiraHandoff && !handoffAt && item.ticket) {
    try {
      await deps.jiraHandoff({ item, pr: { no: pr.number, url: pr.url } });
      handoffAt = deps.clock();
    } catch {
      // Best effort, same discipline as the review comment and the backend ping above.
    }
  }

  // The backend owner's assignment runs after the ticket write-up on purpose: the Jira
  // handoff assigns QA, and for a backend item the owner who lands the PR must be the
  // assignee at the end, not the one overwritten a second later (seen live 2026-09-07).
  if (deps.repoKindFor) {
    const terminal = terminalStateFor(deps.repoKindFor(item.repo!));
    if (terminal.pings === 'backend-owner' && deps.backendHandoff) {
      try {
        await deps.backendHandoff({ item, pr: { no: pr.number } });
      } catch {
        // Best effort, same as the review comment above: a failed ping never blocks
        // review -- the controlled-code merge denial is the real safety net here.
      }
    }
  }

  // A repo on the allow-list whose gate call actually merged ends here, on `done`, with
  // the same `mergedBy`/`mergedAt` marker `mergeItem`'s own click writes -- the
  // merged-elsewhere sweep in `runQueueTick` reads that marker before it will ever say a
  // PR "merged outside the queue". A `merge: true` gate call that did NOT merge (checks
  // still red, a real conflict) falls through to the ordinary `review` landing below,
  // same as any other repo -- the draft PR is still there for a person to look at.
  if (merge && gateResult.merged) {
    const mergedAt = deps.clock();
    const verifying = Boolean(deps.postMergeVerify && item.branch);
    const merged = writeTransition(
      item,
      {
        state: 'done',
        reason: verifying ? 'merged; OTA pending' : `PR #${pr.number} merged`,
        mergedBy: 'queue',
        mergedAt,
        pr: {
          no: pr.number, url: pr.url, draft: false,
          ...(item.changedFiles ? { files: item.changedFiles.length } : {}),
          ...(prAdd !== undefined ? { add: prAdd } : {}),
          ...(prDel !== undefined ? { del: prDel } : {}),
        },
        ...(handoffAt ? { handoffAt } : {}),
        ...(council.attestationPath ? { attestationPath: council.attestationPath } : {}),
      },
      deps, 'queue.done', { hop: 'gate', ...(gateResult.mergeSha ? { mergeSha: gateResult.mergeSha } : {}) },
    );
    if (deps.postMergeVerify && item.branch) {
      void deps.postMergeVerify({ repo: item.repo!, branch: item.branch, ...(gateResult.mergeSha ? { mergeSha: gateResult.mergeSha } : {}) })
        .then((outcome) => outcome
          ? `OTA published: android ${outcome.android}, ios ${outcome.ios}`
          // Matches `otaVerify.ts`'s `DEFAULT_MAX_WAIT_MS` (30 minutes), same as
          // `mergeItem`'s own fallback line.
          : 'merged; deploy run not found after 30 minutes')
        .catch((error: unknown) => `merged; OTA check failed: ${error instanceof Error ? error.message : String(error)}`)
        .then((reason) => {
          const at = deps.clock();
          deps.store.append({ id: item.id, at, reason, updatedAt: at });
        });
    }
    return merged;
  }

  // A.3: the Jira write-back fires once per item, guarded by `handoffAt` rather than by
  // this being the only tick that can ever reach here (belt and braces: `review` is not
  // an in-flight state, so `runQueueTick` never re-enters `advanceItem` for it, but the
  // guard keeps the intent honest even if that ever changes).
  return writeTransition(
    item,
    {
      // A.8/H1.3 fix: real figures off the snapshot fetched above, when one was
      // fetched -- omitted (never a guessed 0) when `deps.prSnapshot` isn't wired, so
      // the board reads "checks/files not read yet" instead of a fabricated zero diff.
      state: 'review',
      pr: {
        no: pr.number, url: pr.url, draft: true,
        ...(item.changedFiles ? { files: item.changedFiles.length } : {}),
        ...(prAdd !== undefined ? { add: prAdd } : {}),
        ...(prDel !== undefined ? { del: prDel } : {}),
      },
      ...(handoffAt ? { handoffAt } : {}),
      ...(council.attestationPath ? { attestationPath: council.attestationPath } : {}),
    },
    deps, 'queue.review', {},
  );
}

/**
 * One tick of the queue worker: refuses to start anything while the kill switch is
 * engaged or the queue itself is paused (both checked fresh, every tick, never cached),
 * then advances every item already `planning`/`running` plus enough `queued` items to
 * fill `maxInFlight`. A paused or kill-switched tick still reports which one stopped it,
 * so a caller can say so honestly rather than silently doing nothing.
 */
/** Items whose `advanceItem` has been entered and has not returned. A council and gate
 *  pass takes minutes while the tick fires every ten seconds, so without this an item
 *  stays `running` across several ticks and each one starts the same work again: a live
 *  run of this queue spawned three concurrent Codex processes for a single item that way.
 *  Module scope rather than a field, because the tick is a free function and one process
 *  owns one queue. */
const advancing = new Set<string>();
const MERGED_SWEEP_MS = 120_000;
let lastMergedSweepAt = 0;
/** Test seam: make the next tick sweep merged PRs regardless of the last sweep time. */
export function resetMergedSweep(): void { lastMergedSweepAt = 0; }

/** True while any item is mid-advance in this process (a council round, a launch, a
 *  handoff). The self loop's cutover reads it so a restart never lands on a hop half
 *  done. */
export function queueBusy(): boolean {
  return advancing.size > 0;
}

/**
 * Item 1 (2026-09-11): one pass over the parked rows, re-reading whatever the park was
 * about and deciding, per item, whether it may move again. Everything it does is
 * journalled -- `queue.recovered` when an item is handed back to the worker,
 * `queue.recovery-held` when the re-read says not yet, `queue.recovery-declined` once
 * for a park no machine can clear. A recovery that leaves no row is how a pipeline lies
 * to its operator, so there is no silent branch here.
 *
 * Bounded by `PARK_RECOVERY_CAP` attempts per item, counted on the item itself, so a
 * park that never clears costs three rows and then stops rather than one row per tick
 * for as long as the console runs.
 */
async function recoverParkedItems(deps: QueueRuntimeDeps, items: QueueItem[], slots: number): Promise<number> {
  let recovered = 0;
  for (const item of items) {
    if (item.state !== 'parked') continue;
    const verdict = parkRecoverability(item.reason);
    const reason = item.reason ?? '';
    if (!verdict.recoverable) {
      // Once per REASON, not once per item and not once per tick: an item that parks on a
      // second, different reason a machine cannot clear still has to say so.
      if (item.recoveryDeclinedFor !== reason) {
        writeTransition(item, { recoveryDeclinedFor: reason }, deps, 'queue.recovery-declined', { why: verdict.why, parkReason: item.reason });
      }
      continue;
    }
    const recoveries = item.recoveryAttempts ?? 0;
    if (recoveries >= PARK_RECOVERY_CAP) {
      // Never a silent stop. One row says the budget is gone and why, then nothing more.
      const why = `recovered ${recoveries} times already and parked again; a person needs to read this one`;
      if (item.recoveryDeclinedFor !== reason) {
        writeTransition(item, { recoveryDeclinedFor: reason }, deps, 'queue.recovery-declined', { why, parkReason: item.reason });
      }
      continue;
    }
    // Item 1, finding 5: a recovery ends in a relaunched worker, so it spends a slot the
    // same way a queued item does. Without this, ten parked rows whose runs are dead
    // provision ten workers on one tick. Journalled once, like every other decision here:
    // an item held back by the width is a decision, and skipping it in silence is the
    // thing this function's own comment promises not to do.
    if (slots <= 0) {
      if (item.recoveryHeldOn !== 'no room at this width') {
        writeTransition(
          item, { recoveryHeldOn: 'no room at this width' }, deps, 'queue.recovery-held',
          { reRead: verdict.reRead, found: 'no room at this width', parkReason: item.reason },
        );
      }
      continue;
    }

    let found: string;
    let clear = false;
    let checksRead = false;
    if (verdict.reRead === 'checks') {
      const reads = item.checksReads ?? 0;
      if (reads >= PARK_CHECKS_RECHECK_CAP) {
        const why = `asked GitHub about these checks ${reads} times without them going green`;
        if (item.recoveryDeclinedFor !== reason) {
          writeTransition(item, { recoveryDeclinedFor: reason }, deps, 'queue.recovery-declined', { why, parkReason: item.reason });
        }
        continue;
      }
      // Silent on purpose, and the only silent branch here: nothing was re-read and
      // nothing was decided, so there is no decision to journal. The window is what keeps
      // this off the rate limit; a row per skipped tick would be four an hour per item
      // saying "did not look yet".
      if (item.checksReadAt !== undefined && deps.clock() - item.checksReadAt < PARK_CHECKS_RECHECK_MS) continue;
      if (!deps.checksConclusion || !item.repo || !item.pr) {
        found = 'no checks reader wired';
      } else {
        checksRead = true;
        found = (await deps.checksConclusion(item.repo, item.pr.no)) ?? 'unknown';
        // Case-insensitive on purpose. The wired reader answers `conclusionOf`'s own
        // lowercase verdict (`council/gh.ts`), and comparing against 'SUCCESS' made this
        // whole branch dead in production while the specimen stayed green.
        clear = found.toLowerCase() === 'success';
      }
    } else if (!deps.runPid) {
      found = 'no liveness reader wired';
    } else {
      const pid = item.runKey ? deps.runPid(item.runKey) : undefined;
      found = pid === undefined ? 'no live process' : `run still alive (pid ${pid})`;
      clear = pid === undefined;
    }

    const readMarks = checksRead
      ? { checksReadAt: deps.clock(), checksReads: (item.checksReads ?? 0) + 1 }
      : {};
    if (!clear) {
      // One row per distinct reading. The tick fires every 15 seconds; a row each time
      // would bury the journal, and a cap on holds would abandon the item.
      if (item.recoveryHeldOn !== found) {
        writeTransition(
          item, { recoveryHeldOn: found, ...readMarks }, deps, 'queue.recovery-held',
          { reRead: verdict.reRead, found, parkReason: item.reason },
        );
      } else if (checksRead) {
        // No decision changed, so no journal row, but the read still has to be counted or
        // the window and the cap both stop working.
        deps.store.append({ id: item.id, at: deps.clock(), ...readMarks });
      }
      continue;
    }
    // Same landing rule `retryItem` uses: a run already exists means this item re-enters
    // at the status/gate hop (`running`), never at the plan/launch hop.
    const state: QueueItemState = item.runKey ? 'running' : 'queued';
    writeTransition(
      item,
      {
        state, reason: null, recoveryAttempts: recoveries + 1, recoveryHeldOn: null, recoveryDeclinedFor: null,
        ...readMarks,
        // `retriedAt` means "a person asked for this run to be looked at again", and
        // `relaunchOnRetryOrPark` answers it by provisioning a NEW worker. That is right
        // for a run that died and wrong for checks that went green: there the run
        // finished correctly and the item only needs its gate hop read again.
        ...(item.runKey && verdict.reRead === 'run' ? { retriedAt: deps.clock() } : {}),
        ...(item.pendingGatePolls ? { pendingGatePolls: 0 } : {}),
      },
      deps, 'queue.recovered',
      { reRead: verdict.reRead, found, parkReason: item.reason, recovery: recoveries + 1, decided: `moved to ${state}` },
    );
    recovered += 1;
    slots -= 1;
  }
  return recovered;
}

export async function runQueueTick(deps: QueueRuntimeDeps, items: QueueItem[]): Promise<QueueTickResult> {
  if (deps.killSwitch()) return { started: 0, advanced: 0, killSwitchEngaged: true, paused: false };
  if (deps.paused()) return { started: 0, advanced: 0, killSwitchEngaged: false, paused: true };

  items = items.filter((item) => !advancing.has(item.id));
  // Item 1: parked rows are re-read first, so an item handed back this tick is advanced
  // on this tick rather than the next one. A recovery ends in a relaunched worker, so it
  // is given only the slots the width has left over after everything already in flight.
  const busy = items.filter((item) => QUEUE_IN_FLIGHT_STATES.includes(item.state) && !isWaitingOnInterview(item));
  if (await recoverParkedItems(deps, items, Math.max(0, deps.maxInFlight() - busy.length))) {
    items = deps.store.all().filter((item) => !advancing.has(item.id));
  }
  const inFlight = items.filter((item) => QUEUE_IN_FLIGHT_STATES.includes(item.state));
  const queued = items.filter((item) => item.state === 'queued');
  // R-76: an item waiting on an interview answer is in `planning` and therefore counts as
  // in flight, but it is not doing any work -- it is waiting on a person. Counting it
  // against the width meant enough unanswered questions starved every queued item behind
  // them, which is the opposite of "one question holds one item". It is still advanced
  // below, so the tick that answers it still wakes it.
  const waitingOnAnswer = inFlight.filter(isWaitingOnInterview);
  let slots = Math.max(0, deps.maxInFlight() - (inFlight.length - waitingOnAnswer.length));
  const toAdvance = [...inFlight];
  let started = 0;
  for (const item of queued) {
    if (slots <= 0) break;
    if (item.after?.length) {
      const reason = await unresolvedAfterReason(item, items, deps);
      if (reason) {
        if (item.reason !== reason) {
          writeTransition(item, { reason }, deps, 'queue.waiting', { hop: 'after' });
        }
        continue;
      }
    }
    slots -= 1;
    started += 1;
    toAdvance.push(item);
  }

  // Review items are not advanced, but a PR merged outside the queue must still close
  // its item. Swept at most every two minutes so a tick stays cheap. `items` can be
  // stale by the time this runs (BBZ-178: the queue's own Merge click landed on the
  // store, between this tick's own read and this loop, on an item this loop's snapshot
  // still shows as 'review'), so before writing "merged outside the queue" every item
  // is re-read straight off the store and skipped if it already carries the queue's own
  // `mergedBy: 'queue'` mark -- that mark is never true unless `mergeItem` wrote it.
  if (deps.prMerged && Date.now() - lastMergedSweepAt >= MERGED_SWEEP_MS) {
    lastMergedSweepAt = Date.now();
    for (const item of items.filter((row) => row.state === 'review' && row.pr && row.repo)) {
      try {
        if (await deps.prMerged(item.repo!, item.pr!.no)) {
          const current = deps.store.get(item.id) ?? item;
          if (current.mergedBy === 'queue') continue;
          writeTransition(item, { state: 'done', reason: `PR #${item.pr!.no} merged outside the queue` }, deps, 'queue.done', { hop: 'merged-elsewhere' });
        }
      } catch {
        // an unreadable PR is not evidence of a merge; the next sweep asks again
      }
    }
  }

  let advanced = 0;
  for (const item of toAdvance) {
    advancing.add(item.id);
    const before = JSON.stringify(item);
    try {
      const next = await advanceItem(item, deps);
      if (JSON.stringify(next) !== before) advanced += 1;
    } finally {
      advancing.delete(item.id);
    }
  }
  return { started, advanced, killSwitchEngaged: false, paused: false };
}

// ---------------------------------------------------------------------------------------
// A.7: Merge and Promote -- always a click, never automatic.
// ---------------------------------------------------------------------------------------

export interface QueueMergeDeps {
  /** The queue's own allow-list, separate from `ChainEnv.mergeRepos` -- a repo the queue
   *  may merge through a click is this environment's own decision, read fresh so an
   *  operator changing it takes effect on the next click. */
  mergeAllowed: (repo: string) => boolean;
  gate: ChainGateFn;
  /** B (2026-09-08): re-councils a PR whose head has moved past its last attestation --
   *  the same dependency shape `advanceItem` already calls the council with. Absent means
   *  a merge refused for a missing attestation stays refused, the behavior every specimen
   *  before this stream already proved. */
  council?: QueueCouncilFn;
  /** B: writes one row to the fleet journal for the re-council itself. Absent means no
   *  journal row is written for it, matching every other optional write in this file. */
  append?: (event: Record<string, unknown>) => QueueJournalWrite;
  /** Polls the develop deploy for its per-platform OTA outcome, once the merge itself
   *  landed. Absent means this environment never wires it, and the item still lands on
   *  `done`, just without an OTA line in its reason. */
  postMergeVerify?: (input: { repo: string; branch: string; mergeSha?: string }) => Promise<{ android: string; ios: string } | undefined>;
  /** R-22: when present, the Merge click lands the PR with git itself: fetch, squash onto
   *  a local checkout of the base, commit, push, instead of `gh pr merge`. That way a
   *  GitHub rate limit on mutations never blocks something already reviewed. The one API
   *  call this environment still spends is the PR create, upstream of this click; nothing
   *  here calls `gh`. Absent means the pre-R-22 `deps.gate({merge:true})` path runs
   *  unchanged, so every existing gate-based specimen keeps passing. */
  gitMerge?: (input: { repo: string; pr: number; branch: string; base: string; subject: string; body: string }) => Promise<{ ok: boolean; mergeSha?: string; reason?: string }>;
  clock(): number;
  store: QueueStore;
}

export interface QueueMergeResult {
  ok: boolean;
  message: string;
  item?: QueueItem;
}

/** A.7: the Merge click. Refuses outright on anything but a `review` item with a PR, and
 *  on a repo this environment hasn't allow-listed -- `gate({merge:true})` is the one
 *  place in this whole file that can ever pass `merge: true`, and it is reached only
 *  from here, only on an operator's own click. */
export async function mergeItem(item: QueueItem, deps: QueueMergeDeps): Promise<QueueMergeResult> {
  if (item.state !== 'review' || !item.pr) {
    return { ok: false, message: `${item.id} is not in review` };
  }
  if (!deps.mergeAllowed(item.repo ?? '')) {
    return { ok: false, message: `${item.repo ?? 'this repo'} is not on the queue's merge allow-list` };
  }

  let result: { merged: boolean; reason?: string[]; mergeSha?: string };
  if (deps.gitMerge) {
    const base = item.base ?? 'develop';
    const gm = await deps.gitMerge({
      repo: item.repo!, pr: item.pr.no, branch: item.branch!, base,
      subject: `Merge ${item.branch} (#${item.pr.no})`, body: '',
    });
    result = gm.ok ? { merged: true, mergeSha: gm.mergeSha } : { merged: false, reason: gm.reason ? [gm.reason] : undefined };
  } else {
    result = await deps.gate({ repo: item.repo!, pr: item.pr.no, merge: true });

    // B (2026-09-08): PR #121 picked up a fix commit after its last council round, and the
    // gate refused with "no attestation for owner/name#9 at head <sha> -- run forge council
    // first" even though the fix was already good -- the attestation the gate wants is for
    // a head that no longer exists. Rather than sending an operator back to run `forge
    // council` by hand, re-council this head once and retry the gate if it clears.
    if (!result.merged && deps.council && (result.reason ?? []).some((line) => line.includes('no attestation for'))) {
      deps.append?.({ event: 'queue.recouncil', actor: 'queue', itemId: item.id, repo: item.repo, pr: item.pr.no });
      const council = await deps.council({
        repo: item.repo!, pr: item.pr.no, forceCodex: true,
        ...(item.worktreePath ? { cwd: item.worktreePath } : {}),
        ...(item.base ? { baseRef: `origin/${item.base}` } : {}),
      });
      const councilCleared = council.verdict === 'PASS' || council.verdict === 'PASS WITH NOTES';
      if (councilCleared) {
        result = await deps.gate({ repo: item.repo!, pr: item.pr.no, merge: true });
      } else {
        const why = result.reason?.length ? result.reason.join(' | ') : 'no reason recorded';
        const summary = council.coverageNote ? `${council.verdict}: ${council.coverageNote}` : council.verdict;
        return { ok: false, message: `the merge did not complete: ${why} (recouncil: ${summary})` };
      }
    }
  }

  if (!result.merged) {
    const why = result.reason?.length ? result.reason.join(' | ') : 'no reason recorded';
    return { ok: false, message: `the merge did not complete: ${why}` };
  }

  // The item is done the moment the merge lands. The develop deploy takes minutes, so
  // the per-platform OTA outcome is written as a second row when the verifier answers,
  // and the click's own response never waits on it. A verifier that finds no run says
  // so in the reason, so 'OTA pending' can never be the item's last word.
  //
  // `mergedBy`/`mergedAt` (BBZ-178): the only record that this merge was the queue's own
  // -- the merged-elsewhere sweep in `runQueueTick` checks it before it will ever write
  // "merged outside the queue".
  const now = deps.clock();
  const verifying = Boolean(deps.postMergeVerify && item.branch);
  const patch: Partial<QueueItem> = {
    state: 'done', reason: verifying ? 'merged; OTA pending' : null, updatedAt: now,
    mergedBy: 'queue', mergedAt: now,
  };
  deps.store.append({ id: item.id, at: now, ...patch });
  if (deps.postMergeVerify && item.branch) {
    void deps.postMergeVerify({ repo: item.repo!, branch: item.branch, ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}) })
      .then((outcome) => outcome
        ? `OTA published: android ${outcome.android}, ios ${outcome.ios}`
        // Matches `otaVerify.ts`'s `DEFAULT_MAX_WAIT_MS` (30 minutes) -- an operator
        // reading this reason gets the cap that was actually enforced, not a guess.
        : 'merged; deploy run not found after 30 minutes')
      .catch((error: unknown) => `merged; OTA check failed: ${error instanceof Error ? error.message : String(error)}`)
      .then((reason) => {
        const at = deps.clock();
        deps.store.append({ id: item.id, at, reason, updatedAt: at });
      });
  }
  return { ok: true, message: patch.reason ?? 'merged', item: { ...item, ...patch } };
}

export interface QueuePromoteDeps {
  /** Whether the production publish workflow exists on this repo's develop tip --
   *  checked fresh on every click, per the plan: Promote 501s with a reason rather than
   *  dispatching into a workflow that was never provisioned. */
  productionWorkflowExists: (repo: string) => Promise<boolean>;
  /** The dispatch itself. Deliberately absent in this stream's own production wiring --
   *  a real production publish is a decision an operator makes explicitly, not a
   *  default this queue ships wired to fire on a click alone (standing order 9). Wiring
   *  it is a follow-up once that decision is made. */
  promote?: (input: { item: QueueItem; version: string; message: string }) => Promise<void>;
}

export interface QueuePromoteResult {
  ok: boolean;
  code: number;
  message: string;
}

/** A.7: the Promote click -- production only, and only for a hotfix item that already
 *  shipped to dev on Merge. 501s by name, never a bare failure, when the production
 *  workflow isn't on develop yet or this environment never wired the dispatch. */
export async function promoteItem(
  item: QueueItem, input: { version: string; message: string }, deps: QueuePromoteDeps,
): Promise<QueuePromoteResult> {
  if (item.source !== 'hotfix') {
    return { ok: false, code: 400, message: 'only a hotfix item can be promoted to production' };
  }
  if (item.state !== 'done') {
    return { ok: false, code: 409, message: `${item.id} has not shipped to dev yet -- Merge it first` };
  }
  const exists = await deps.productionWorkflowExists(item.repo ?? '');
  if (!exists) {
    return {
      ok: false, code: 501,
      message: `the production publish workflow is not on ${item.repo ?? 'this repo'}'s develop yet`,
    };
  }
  if (!deps.promote) {
    return { ok: false, code: 501, message: 'no production publish wiring is configured for this environment' };
  }
  await deps.promote({ item, version: input.version, message: input.message });
  return { ok: true, code: 200, message: `production publish dispatched for ${input.version}` };
}
