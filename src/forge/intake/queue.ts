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
import type { QueueStore } from './queueStore.js';

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
  council: ChainCouncilFn;
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

  if (status.verdict !== 'done') {
    return writeTransition(item, { state: 'parked', reason: status.verdict ?? 'unknown' }, deps, 'queue.parked', { hop: 'gate' });
  }

  let pr = status.prUrl ? prFromUrl(status.prUrl) : undefined;
  if (!pr && item.branch) pr = await deps.gh.findPrByHead(item.repo!, item.branch);
  if (!pr) {
    return writeTransition(
      item, { state: 'parked', reason: 'run finished done but no PR was found in its evidence or on its branch' },
      deps, 'queue.parked', { hop: 'gate' },
    );
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
    return writeTransition(item, { state: 'parked', reason: council.verdict }, deps, 'queue.parked', { hop: 'gate' });
  }

  // The one line that makes "every item stops at a draft PR" true: `merge` is always
  // `false`, never `deps.mergeAllowed`-derived or otherwise conditional.
  await deps.gate({ repo: item.repo!, pr: pr.number, merge: false });

  return writeTransition(
    item, { state: 'review', pr: { no: pr.number, url: pr.url, files: 0, add: 0, del: 0, draft: true } },
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
