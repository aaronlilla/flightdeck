/**
 * Boot reconcile: bring the machine's idea of the world back in line with the world,
 * before the queue and the Jira watcher are allowed to start.
 *
 * Every pass here exists because of a real stale-state incident, and every one of them
 * is a reconciliation nothing else performs:
 *
 * - **Checkout bases drift.** `chain-wire.ts`'s `provisionRunClone` fetches `origin/<base>`
 *   and then clones from the checkout's own local branch, which the fetch does not move.
 *   On 2026-09-21 the v2-React-Native helper checkout's `develop` sat 86 commits behind
 *   GitHub, so every run provisioned from it started on weeks-old code and reported that
 *   its ticket's premise was wrong (BBZ-359).
 * - **Reused run clones drift further.** A clone that already exists is deliberately
 *   reused so a resumed run finds its work, and nothing ever refreshes it afterwards. The
 *   same day, one live item's clone was 85 commits behind trunk.
 * - **Asks outlive their runs.** `isAskStale` computes staleness for display only; the
 *   only thing that retires an ask is a person running `forge clear --all`. 113 of 116
 *   open questions belonged to queue items that no longer existed.
 * - **Asks outlive their answers.** A question relayed from a Jira comment stays open even
 *   after the operator answers it in Jira, because the feed records only what it posted
 *   and never re-reads the ticket. 43 of 66 relayed asks had been answered days earlier.
 *
 * Two contracts hold for every pass:
 *
 * - **A pass reports; it never throws.** A reconcile that cannot reach GitHub or Jira must
 *   not stop a console from starting -- a stale board is bad, no board is worse. Each pass
 *   returns its own `failures` and the caller journals them.
 * - **Nothing is deleted.** A retired ask is moved under `inbox/retired/`, which is what
 *   `Inbox.retire` already does, so what was asked and why it was dropped stay on disk.
 */
import type { Inbox, InboxEntry } from './inbox.js';
import { isAskStale, ITEM_RUN_PREFIX } from './inbox.js';

/** One `git` invocation, injected so specimens never shell out. Resolves with the
 *  command's own success flag and trimmed stdout; a throw is the caller's failure, not a
 *  reason to abandon the pass. */
export type GitRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

/** A repository this console provisions runs from: the checkout on disk and the branch
 *  runs are cut from. Built from `FORGE_REPO_CHECKOUTS`/`FORGE_REPO_BASES` by the caller,
 *  so this module never reads the environment itself. */
export interface ReconcileRepo {
  repo: string;
  checkout: string;
  base: string;
}

export interface CheckoutOutcome {
  repo: string;
  checkout: string;
  base: string;
  /** Commits the local base branch was behind its remote before this pass. `0` means it
   *  was already current; the field is the evidence the pass did something. */
  behindBefore: number;
  /** True when the local branch was moved onto the remote's commit. A checkout with a
   *  dirty working tree or a diverged base is reported and left alone. */
  fastForwarded: boolean;
  reason?: string;
}

export interface ClonePass {
  ticket: string;
  clonePath: string;
  behindBefore: number;
  refreshed: boolean;
  reason?: string;
}

/** The pseudo-run names a relayed ask carries instead of a real run id. An entry whose
 *  every run is one of these was raised by a poller, so no registry row will ever exist
 *  for it and "all its runs are gone" is meaningless. */
const FEED_RUNS = new Set(['jira-feed', 'slack']);

export interface RetiredAsk {
  key: string;
  ticket?: string;
  why: string;
}

export interface BootReconcileResult {
  checkouts: CheckoutOutcome[];
  clones: ClonePass[];
  retired: RetiredAsk[];
  failures: string[];
  /** One line per pass, in the order they ran, for the boot log. */
  lines: string[];
}

/** How far `local` is behind `remote`, or `undefined` when the count cannot be read. */
async function behindCount(git: GitRun, cwd: string, local: string, remote: string): Promise<number | undefined> {
  const counted = await git(cwd, ['rev-list', '--count', `${local}..${remote}`]);
  if (!counted.ok) return undefined;
  const n = Number(counted.out.trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pass 1: fast-forward every configured checkout's base branch onto its remote.
 *
 * `update-ref` rather than `merge --ff-only` deliberately: the helper checkouts runs are
 * cloned from sit on a detached HEAD with no working tree of their own, so a merge has
 * nothing to run in, while the ref move is exactly what the clone below it reads. A
 * checkout whose HEAD is actually on that branch gets the merge instead, so an operator's
 * working tree is never rewritten under them.
 */
export async function reconcileCheckouts(
  repos: ReconcileRepo[], git: GitRun,
): Promise<{ outcomes: CheckoutOutcome[]; failures: string[] }> {
  const outcomes: CheckoutOutcome[] = [];
  const failures: string[] = [];
  for (const entry of repos) {
    const base = { repo: entry.repo, checkout: entry.checkout, base: entry.base };
    try {
      const fetched = await git(entry.checkout, ['fetch', '--prune', 'origin', entry.base]);
      if (!fetched.ok) {
        failures.push(`${entry.repo}: could not fetch origin/${entry.base}`);
        outcomes.push({ ...base, behindBefore: 0, fastForwarded: false, reason: 'fetch failed' });
        continue;
      }
      const behind = await behindCount(git, entry.checkout, entry.base, `origin/${entry.base}`);
      if (behind === undefined) {
        outcomes.push({ ...base, behindBefore: 0, fastForwarded: false, reason: `no local ${entry.base} branch` });
        continue;
      }
      if (behind === 0) {
        outcomes.push({ ...base, behindBefore: 0, fastForwarded: false, reason: 'already current' });
        continue;
      }
      // A base that has commits the remote does not is a divergence, not a lag: moving the
      // ref would silently drop them. Report and leave it for a person.
      const ahead = await behindCount(git, entry.checkout, `origin/${entry.base}`, entry.base);
      if (ahead !== undefined && ahead > 0) {
        outcomes.push({ ...base, behindBefore: behind, fastForwarded: false, reason: `diverged: ${ahead} local commit(s) not on origin` });
        failures.push(`${entry.repo}: ${entry.base} has diverged from origin and was left alone`);
        continue;
      }
      const head = await git(entry.checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const onBase = head.ok && head.out.trim() === entry.base;
      const moved = onBase
        ? await git(entry.checkout, ['merge', '--ff-only', `origin/${entry.base}`])
        : await git(entry.checkout, ['update-ref', `refs/heads/${entry.base}`, `refs/remotes/origin/${entry.base}`]);
      if (!moved.ok) {
        outcomes.push({ ...base, behindBefore: behind, fastForwarded: false, reason: 'fast-forward refused' });
        failures.push(`${entry.repo}: ${entry.base} was ${behind} behind and could not be fast-forwarded`);
        continue;
      }
      outcomes.push({ ...base, behindBefore: behind, fastForwarded: true });
    } catch (error) {
      failures.push(`${entry.repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { outcomes, failures };
}

/** A run clone a live queue item owns. `dirty` clones are refreshed by rebase-free fetch
 *  only, never by moving the branch under uncommitted work. */
export interface CloneToCheck {
  ticket: string;
  clonePath: string;
  base: string;
}

/**
 * Pass 2: report (and where safe, close) how far each live run clone is behind its base.
 *
 * A clone with uncommitted work is never moved -- that work is the run's, and discarding
 * it is exactly the failure mode `provisionRunClone`'s reuse exists to prevent. A clean
 * clone with no commits of its own is fast-forwarded, because it is indistinguishable from
 * a fresh provision except in age.
 */
export async function reconcileRunClones(
  clones: CloneToCheck[], git: GitRun,
): Promise<{ passes: ClonePass[]; failures: string[] }> {
  const passes: ClonePass[] = [];
  const failures: string[] = [];
  for (const clone of clones) {
    try {
      const fetched = await git(clone.clonePath, ['fetch', '--prune', 'origin', clone.base]);
      if (!fetched.ok) {
        passes.push({ ticket: clone.ticket, clonePath: clone.clonePath, behindBefore: 0, refreshed: false, reason: 'fetch failed' });
        failures.push(`${clone.ticket}: could not fetch origin/${clone.base} in its run clone`);
        continue;
      }
      const behind = await behindCount(git, clone.clonePath, 'HEAD', `origin/${clone.base}`);
      if (behind === undefined || behind === 0) {
        passes.push({ ticket: clone.ticket, clonePath: clone.clonePath, behindBefore: behind ?? 0, refreshed: false, reason: 'already current' });
        continue;
      }
      const status = await git(clone.clonePath, ['status', '--porcelain']);
      if (!status.ok || status.out.trim() !== '') {
        passes.push({ ticket: clone.ticket, clonePath: clone.clonePath, behindBefore: behind, refreshed: false, reason: 'uncommitted work left alone' });
        continue;
      }
      const own = await behindCount(git, clone.clonePath, `origin/${clone.base}`, 'HEAD');
      if (own !== undefined && own > 0) {
        passes.push({ ticket: clone.ticket, clonePath: clone.clonePath, behindBefore: behind, refreshed: false, reason: `${own} commit(s) of its own, left alone` });
        continue;
      }
      const moved = await git(clone.clonePath, ['merge', '--ff-only', `origin/${clone.base}`]);
      passes.push({
        ticket: clone.ticket, clonePath: clone.clonePath, behindBefore: behind,
        refreshed: moved.ok, ...(moved.ok ? {} : { reason: 'fast-forward refused' }),
      });
    } catch (error) {
      failures.push(`${clone.ticket}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passes, failures };
}

/**
 * Pass 3: retire every open ask whose runs are all gone.
 *
 * This is `forge clear --all`'s own rule, run automatically at boot instead of waiting for
 * a person to notice. `isAskStale` is the single definition of "gone" and is reused rather
 * than restated, including its deliberate exemption for item-scoped asks whose queue item
 * still exists.
 */
export function retireDeadAsks(
  inbox: Pick<Inbox, 'open' | 'retire'>,
  hasRegistryRow: (run: string) => boolean,
  liveQueueItemIds: ReadonlySet<string>,
  now: number = Date.now(),
): RetiredAsk[] {
  const retired: RetiredAsk[] = [];
  for (const entry of inbox.open()) {
    // A question relayed from a Jira comment belongs to the feed, not to a run: its
    // `runs` is `['jira-feed']`, which never has a registry row, so the dead-run rule
    // would retire every one of them the moment it ran -- including the operator
    // questions a person is genuinely waiting on. Only pass 4's evidence (an answer on
    // the ticket) may retire these.
    if (entry.runs.every((run) => FEED_RUNS.has(run))) continue;
    const itemRuns = entry.runs.filter((run) => run.startsWith(ITEM_RUN_PREFIX));
    // An item-scoped ask is exempt from `isAskStale` on purpose (a queued item has no
    // registry row until it launches), so its own liveness is the queue, not the registry.
    const itemGone = itemRuns.length > 0
      && itemRuns.every((run) => !liveQueueItemIds.has(run.slice(ITEM_RUN_PREFIX.length)));
    if (!itemGone && !isAskStale(entry as InboxEntry, hasRegistryRow, now)) continue;
    if (!inbox.retire(entry.key)) continue;
    retired.push({
      key: entry.key,
      ...(entry.ticket ? { ticket: entry.ticket } : {}),
      why: itemGone ? 'its queue item is gone' : 'every run that asked it is gone',
    });
  }
  return retired;
}

/** A Jira comment, reduced to what deciding "was this answered" needs. */
export interface TicketComment {
  authorAccountId: string;
  createdMs: number;
}

/** What a ticket looks like to the reconcile: who owns it, and whether it is still live.
 *  Absent from the map means the ticket could not be read, which is never evidence. */
export interface TicketState {
  assigneeAccountId: string | null;
  /** The status category, not the status name: every board names its columns
   *  differently, but `done` is the one category Jira guarantees. */
  statusIsDone: boolean;
}

/** Jira statuses aside, an ask on a ticket somebody else owns is not the operator's
 *  work. This is the rule that would have kept fourteen of Haiping's own In Review
 *  tickets off the board in the first place. */
function notTheOperators(state: TicketState | undefined, operatorAccountId: string): boolean {
  if (!state) return false;
  return state.assigneeAccountId !== operatorAccountId;
}

/**
 * Pass 4: retire relayed Jira asks that are not the operator's to answer any more.
 *
 * Three ways an ask stops being live, all read off the ticket itself rather than off the
 * board:
 *
 * - The operator replied after the comment the ask relays. **After the COMMENT, not after
 *   the ask was raised**: the feed polls, so an ask can be minted a minute after the reply
 *   it was already answered by, and comparing against the raise time then keeps four
 *   answered tickets on the board looking live. `sourceCommentAt` is the comparison;
 *   `at` is only the fallback for entries written before that field existed.
 * - The ticket is assigned to somebody else. A teammate reporting test results on their
 *   own ticket is doing their job, not waiting on the operator.
 * - The ticket is Done.
 *
 * A ticket whose state could not be read retires nothing. A missing read must never be
 * mistaken for "nobody answered".
 */
export function retireAnsweredJiraAsks(
  inbox: Pick<Inbox, 'open' | 'retire'>,
  operatorAccountId: string,
  commentsByTicket: ReadonlyMap<string, TicketComment[]>,
  ticketStates: ReadonlyMap<string, TicketState> = new Map(),
): RetiredAsk[] {
  const retired: RetiredAsk[] = [];
  for (const entry of inbox.open()) {
    const ticket = entry.ticket;
    if (!ticket) continue;
    const state = ticketStates.get(ticket);
    let why: string | undefined;
    if (notTheOperators(state, operatorAccountId)) {
      why = 'the ticket is assigned to somebody else';
    } else if (state?.statusIsDone) {
      why = 'the ticket is done';
    } else {
      const comments = commentsByTicket.get(ticket);
      // A ticket whose comments could not be read is not evidence of anything.
      if (!comments) continue;
      // One second of slack against the relayed comment's own timestamp: the comment and
      // the ask can share a clock tick, and retiring an ask on the comment that raised it
      // would be wrong.
      const since = entry.sourceCommentAt ?? entry.at;
      if (comments.some((c) => c.authorAccountId === operatorAccountId && c.createdMs > since + 1000)) {
        why = 'answered on the ticket after the comment it relays';
      }
    }
    if (!why) continue;
    if (!inbox.retire(entry.key)) continue;
    retired.push({ key: entry.key, ticket, why });
  }
  return retired;
}

export interface BootReconcileDeps {
  repos: ReconcileRepo[];
  clones: CloneToCheck[];
  git: GitRun;
  inbox: Pick<Inbox, 'open' | 'retire'>;
  hasRegistryRow: (run: string) => boolean;
  liveQueueItemIds: ReadonlySet<string>;
  /** Absent when Jira is not configured or unreachable: pass 4 then retires nothing
   *  rather than guessing. */
  jira?: {
    operatorAccountId: string;
    commentsByTicket: ReadonlyMap<string, TicketComment[]>;
    ticketStates?: ReadonlyMap<string, TicketState>;
  };
  now?: number;
}

/** Runs all four passes in order and summarises them for the boot log. */
export async function bootReconcile(deps: BootReconcileDeps): Promise<BootReconcileResult> {
  const now = deps.now ?? Date.now();
  const checkouts = await reconcileCheckouts(deps.repos, deps.git);
  const clones = await reconcileRunClones(deps.clones, deps.git);
  const deadAsks = retireDeadAsks(deps.inbox, deps.hasRegistryRow, deps.liveQueueItemIds, now);
  const answeredAsks = deps.jira
    ? retireAnsweredJiraAsks(
      deps.inbox, deps.jira.operatorAccountId, deps.jira.commentsByTicket, deps.jira.ticketStates ?? new Map(),
    )
    : [];
  const movedCheckouts = checkouts.outcomes.filter((o) => o.fastForwarded);
  const movedClones = clones.passes.filter((p) => p.refreshed);
  const lines = [
    `reconcile: ${movedCheckouts.length} of ${checkouts.outcomes.length} checkout base(s) fast-forwarded`
      + (movedCheckouts.length ? ` (${movedCheckouts.map((o) => `${o.repo} +${o.behindBefore}`).join(', ')})` : ''),
    `reconcile: ${movedClones.length} of ${clones.passes.length} run clone(s) refreshed`,
    `reconcile: retired ${deadAsks.length} dead ask(s) and ${answeredAsks.length} already-answered ask(s)`,
  ];
  return {
    checkouts: checkouts.outcomes,
    clones: clones.passes,
    retired: [...deadAsks, ...answeredAsks],
    failures: [...checkouts.failures, ...clones.failures],
    lines,
  };
}
