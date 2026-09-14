/**
 * Whether a machine can settle a park on its own, read from the reason the queue wrote.
 *
 * Shared rather than server-only since 2026-09-13: the queue screen decides which control
 * a parked row shows from this same judgement, and a row offering Retry on a park no retry
 * can change was the only control fifteen live rows had. Pure string matching, no imports,
 * so the browser can read it without dragging a server module into the bundle.
 */
/** How many times the queue will recover one park on its own before handing it over. Lives
 *  here so the screen reads the same number the queue enforces; `queue.ts` re-exports it
 *  under its old name. */
export const PARK_RECOVERY_CAP = 3;

/** Whether automatic recovery has given up on this item. The queue says so out loud when
 *  it happens -- "recovered 3 times already and parked again; a person needs to read this
 *  one" -- and until 2026-09-13 the row went on offering Retry, which is the one thing the
 *  queue had already decided would not work. */
export function recoveryIsSpent(attempts: number | null | undefined): boolean {
  return (attempts ?? 0) >= PARK_RECOVERY_CAP;
}

/** What a recoverable park asks to be re-read: the pull request's checks, or the run. */
export type ParkRecheck = 'checks' | 'run';

export type ParkRecoverability =
  | { recoverable: true; reRead: ParkRecheck }
  /** `personsCall` marks a reason this file RECOGNISES and refuses on purpose -- a merge
   *  conflict, an unrouted ticket, a backend hand-off, a spent budget. A reason no rule
   *  covers is also `recoverable: false`, but it carries no `personsCall`: nobody has
   *  judged it, and another pass may still have an opinion about it. */
  | { recoverable: false; why: string; personsCall?: true };

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
    return { recoverable: false, why: 'a merge conflict is a person\'s call, not a stale reading', personsCall: true };
  }
  if (/^unrouted$/i.test(text)) return { recoverable: false, why: 'nothing routed the ticket to a repository', personsCall: true };
  if (/^backend:/i.test(text)) return { recoverable: false, why: 'the ticket was handed to the backend', personsCall: true };
  // The planner found the work already shipped. Nothing about that changes on a retry,
  // and the unclassified default is "retry" -- so until 2026-09-13 the restart sweep
  // re-planned fifteen of these every ten minutes, each one a planner call, each one
  // parking again on the same sentence three seconds later. Traced on the live board
  // through three identical cycles of one ticket. Whether to close the ticket, reopen it
  // or leave it is a person's call, and it only has to be made once.
  if (/^\S+ already has (a|an) (merged|open) pull request\b/i.test(text)) {
    return { recoverable: false, why: 'its pull request already exists; re-planning it cannot change that', personsCall: true };
  }
  // A person's call, after trying twice to make it automatic (2026-09-11). Reading "has
  // the holder released these files" off the store looked free and was not: a PARKED
  // holder still owns its worktree and its file list; the reason is matched by a regex
  // that unparked the item when it MISSED; one ticket key can name two live items, so the
  // wrong row can answer; and when a hot file's queue drains, every item behind it unparks
  // on one tick and takes the width with it. The park costs a click. Getting it wrong puts
  // two workers on one working tree, which is the thing this park exists to prevent.
  if (/^overlaps /i.test(text)) {
    return { recoverable: false, why: 'another item holds the same files', personsCall: true };
  }
  // 2026-09-14: BBZ-202's launch died on this for hours, ten minutes at a time. The
  // colliding tree can hold unpushed commits (BBZ-202's did), so whether it is adopted
  // or cleared is a person's call -- a relaunch only collides with it again.
  if (/is already used by worktree at/i.test(text)) {
    return { recoverable: false, why: 'its branch is checked out in an existing worktree; adopt or clear that tree first', personsCall: true };
  }
  if (/checks (never settled|are pending)/i.test(text)) return { recoverable: true, reRead: 'checks' };
  // Every run verdict `relaunchOnRetryOrPark` passes through (`stopped`, `exhausted`,
  // `parked`, `unknown`) plus the launcher's own stale-liveness refusal: all of them are
  // about a process, and all of them are answered by asking whether one is still alive.
  // `exhausted` is deliberately absent: a run that hit its budget ceiling did not fail
  // on a stale reading, and relaunching it three more times only proves the ceiling again.
  if (/^exhausted$/i.test(text)) return { recoverable: false, why: 'the run spent its budget ceiling', personsCall: true };
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
