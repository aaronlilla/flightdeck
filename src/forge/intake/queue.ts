/**
 * The intake queue: how work gets INTO Forge rather than only supervised once it is
 * already running. Four sources feed it -- a Jira ticket key, a pasted brief, a JQL query
 * naming a sprint or epic, and the backlog with an operator's own filter -- and the
 * worker in `runQueueTick` drives each item through the same shape `chain.ts` already
 * proved for a poll-sourced packet: plan, provision, launch, gate. The one difference
 * that matters: `advanceItem` never calls `deps.gate` with `merge: true`. Every item that
 * clears the gate stops at `review` with a draft PR, full stop -- there is no code path
 * in this file that can merge anything.
 *
 * Every dependency here is a function this module is handed, the same separation
 * `chain.ts` keeps from `chain-wire.ts`: nothing in this file touches the network,
 * spawns a process, or reads `~/.forge` itself. `queue-wire.ts` is where a real Jira
 * search, a real planner and the real `chainLauncher`/`chainGh`/`chainCouncil`/`chainGate`
 * get wired together; every specimen in this stream builds its own `QueueRuntimeDeps`
 * from plain functions instead.
 */
import { randomUUID } from 'node:crypto';

import type { ChainCouncilFn, ChainGateFn, ChainGh, ChainLauncher } from '../chain.js';
import type { QueueItem, QueueItemState, QueueSource } from '../../shared/console-model.js';
import { evaluateAction } from '../rules/index.js';
import { renderNotes } from '../council/renderNotes.js';
import { terminalStateFor, type RepoKind } from './handoff.js';
import type { QueueStore } from './queueStore.js';

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

// ---------------------------------------------------------------------------------------
// Adding work
// ---------------------------------------------------------------------------------------

function newItemId(): string {
  return `Q-${randomUUID().slice(0, 8)}`;
}

function blankItem(id: string, source: QueueSource, input: string, ticket: string | null, at: number): QueueItem {
  return {
    id, source, input, ticket, repo: null, briefPath: null, branch: null, worktreePath: null, base: null,
    state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: at, updatedAt: at,
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

export interface QueuePlanner {
  planTicket(ticket: string): Promise<QueuePlannedBrief>;
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

export function addBriefItem(store: QueueStore, briefText: string, now: number = Date.now()): QueueItem {
  const item = blankItem(newItemId(), 'brief', briefText, null, now);
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
  store.append({ id, at: now, state, reason: null, updatedAt: now });
  return { ...item, state, reason: null, updatedAt: now };
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
  /** Reused from `chain.ts` unchanged, but `advanceItem` never passes `merge: true` --
   *  the queue's own decision (every item stops at a draft PR) lives in this file, not
   *  in whatever the caller wires this to. */
  gate: ChainGateFn;
  clock(): number;
  killSwitch(): boolean;
  paused(): boolean;
  maxInFlight: number;
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

  if (!item.briefPath) {
    if (item.state !== 'planning') item = writeTransition(item, { state: 'planning' }, deps, 'queue.planning');
    let planned: QueuePlannedBrief;
    try {
      planned = item.source === 'brief'
        ? await deps.planner.planBrief(item.input)
        : item.source === 'hotfix'
          ? await (deps.planner.planHotfix ?? deps.planner.planBrief)(item.input)
          : await deps.planner.planTicket(item.ticket ?? item.input);
    } catch (error) {
      return writeTransition(item, { state: 'failed', reason: tailOf(messageOf(error)) }, deps, 'queue.failed', { hop: 'plan' });
    }
    if (planned.repo === 'unknown') {
      return writeTransition(
        item, { ticket: planned.ticket, briefPath: planned.briefPath, repo: planned.repo, state: 'parked', reason: 'unrouted' },
        deps, 'queue.parked', { hop: 'plan' },
      );
    }
    // Planned, not yet launched: returned rather than falling through, so provisioning
    // and launch happen on the tick that follows, one hop per call the same way
    // `chain.ts`'s own planning hop (`runChainTick`) never launches in the same pass
    // that wrote `intake.planned`.
    return writeTransition(
      item, { ticket: planned.ticket, briefPath: planned.briefPath, repo: planned.repo, state: 'running' },
      deps, 'queue.planned', { repo: planned.repo },
    );
  }

  if (!item.runKey) {
    try {
      const provisioned = await deps.launcher.provision({ packetId: item.id, ticket: item.ticket!, repo: item.repo! });
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
      return writeTransition(item, { state: 'failed', reason: tailOf(messageOf(error)) }, deps, 'queue.failed', { hop: 'launch' });
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
    if (status.verdict === 'unverified' && pr) {
      deps.append({ event: 'queue.unverified-pr', actor: 'queue', itemId: item.id, pr: pr.number, url: pr.url });
    } else {
      return writeTransition(item, { state: 'parked', reason: status.verdict ?? 'unknown' }, deps, 'queue.parked', { hop: 'gate' });
    }
  }
  if (!pr) {
    return writeTransition(
      item, { state: 'parked', reason: 'run finished done but no PR was found in its evidence or on its branch' },
      deps, 'queue.parked', { hop: 'gate' },
    );
  }

  // A.8/A.9: one fetch of the PR's own changed files and line counts, right after the PR
  // is found and before the council or the overlap check reads either -- shared by A.9's
  // overlap check below and A.8's real figures once the item reaches `review`, so this
  // never fetches the same PR's diff twice within one call.
  let prAdd = 0;
  let prDel = 0;
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

  // The one line that makes "every item stops at a draft PR" true: `merge` is always
  // `false`, never `deps.mergeAllowed`-derived or otherwise conditional.
  await deps.gate({ repo: item.repo!, pr: pr.number, merge: false });

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

  // A.3: the Jira write-back fires once per item, guarded by `handoffAt` rather than by
  // this being the only tick that can ever reach here (belt and braces: `review` is not
  // an in-flight state, so `runQueueTick` never re-enters `advanceItem` for it, but the
  // guard keeps the intent honest even if that ever changes).
  let handoffAt = item.handoffAt;
  if (deps.jiraHandoff && !handoffAt && item.ticket) {
    try {
      await deps.jiraHandoff({ item, pr: { no: pr.number, url: pr.url } });
      handoffAt = deps.clock();
    } catch {
      // Best effort, same discipline as the review comment and the backend ping above.
    }
  }

  return writeTransition(
    item,
    {
      // A.8: real figures off the snapshot fetched above, when one was fetched -- the
      // honest zeros from before this stream stand unchanged when `deps.prSnapshot`
      // isn't wired.
      state: 'review',
      pr: { no: pr.number, url: pr.url, files: item.changedFiles?.length ?? 0, add: prAdd, del: prDel, draft: true },
      ...(handoffAt ? { handoffAt } : {}),
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

/** True while any item is mid-advance in this process (a council round, a launch, a
 *  handoff). The self loop's cutover reads it so a restart never lands on a hop half
 *  done. */
export function queueBusy(): boolean {
  return advancing.size > 0;
}

export async function runQueueTick(deps: QueueRuntimeDeps, items: QueueItem[]): Promise<QueueTickResult> {
  if (deps.killSwitch()) return { started: 0, advanced: 0, killSwitchEngaged: true, paused: false };
  if (deps.paused()) return { started: 0, advanced: 0, killSwitchEngaged: false, paused: true };

  items = items.filter((item) => !advancing.has(item.id));
  const inFlight = items.filter((item) => QUEUE_IN_FLIGHT_STATES.includes(item.state));
  const queued = items.filter((item) => item.state === 'queued');
  let slots = Math.max(0, deps.maxInFlight - inFlight.length);
  const toAdvance = [...inFlight];
  let started = 0;
  for (const item of queued) {
    if (slots <= 0) break;
    slots -= 1;
    started += 1;
    toAdvance.push(item);
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
  /** Polls the develop deploy for its per-platform OTA outcome, once the merge itself
   *  landed. Absent means this environment never wires it, and the item still lands on
   *  `done`, just without an OTA line in its reason. */
  postMergeVerify?: (input: { repo: string; branch: string }) => Promise<{ android: string; ios: string } | undefined>;
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

  const result = await deps.gate({ repo: item.repo!, pr: item.pr.no, merge: true });
  if (!result.merged) {
    return { ok: false, message: 'the merge did not complete -- see the journal for the gate\'s own reason' };
  }

  // The item is done the moment the merge lands. The develop deploy takes minutes, so
  // the per-platform OTA outcome is written as a second row when the verifier answers,
  // and the click's own response never waits on it. A verifier that finds no run says
  // so in the reason, so 'OTA pending' can never be the item's last word.
  const now = deps.clock();
  const verifying = Boolean(deps.postMergeVerify && item.branch);
  const patch: Partial<QueueItem> = { state: 'done', reason: verifying ? 'merged; OTA pending' : null, updatedAt: now };
  deps.store.append({ id: item.id, at: now, ...patch });
  if (deps.postMergeVerify && item.branch) {
    void deps.postMergeVerify({ repo: item.repo!, branch: item.branch })
      .then((outcome) => outcome
        ? `OTA landed ios=${outcome.ios} android=${outcome.android}`
        : 'merged; no develop deploy run was found for this merge')
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
