/**
 * F.4: once a self-fix merges, the live console moves onto the new head WHEN IDLE
 * (Aaron, 2026-09-07 11:40). Named `selfCutover.ts` rather than `cutover.ts` -- that
 * name is already taken, by the unrelated fleet-home move (`cutover.ts` retires the old
 * conductor's spawn files; this restarts the running process onto a moved `origin/main`).
 *
 * `cutoverDue` is the whole decision, and it is deliberately conservative: a moved
 * `origin/main` alone is not enough, and neither is idleness alone. Both together are
 * what makes a restart safe -- a fleet mid-council-round or mid-hop restarted out from
 * under itself loses exactly the work this stream exists to protect.
 *
 * The restart itself is never performed here. `cutoverDue` answers the question and
 * journals `self.restart`; the caller (the launcher loop, wired outside this stream) is
 * what actually exits the process with code 75 so the supervising loop restarts it. This
 * file never kills a worker and never touches a run in flight.
 */
import type { QueueItem, QueueItemState } from '../../shared/console-model.js';

/**
 * Item 5 (2026-09-11): the fleet states that must block a cutover. Deliberately WIDER
 * than `QUEUE_IN_FLIGHT_STATES`, which answers a different question -- how many items the
 * queue may work at once. `review` is the one state where a PERSON is being waited on,
 * and restarting under a pending merge click is the loss this guards.
 *
 * Of the two shapes the brief offered -- count `review` as in flight, or refuse a
 * cutover while any confirm is pending -- this is the first, because it does not depend
 * on a confirm having been minted yet: the click that gets voided is often one that has
 * not been made. The cost is that a row left at `review` delays a self-restart until it
 * is merged or removed, which is a delay, never lost work.
 */
// Spelled out rather than imported from `intake/queue.ts`: that module pulls in the
// whole intake graph, and importing it here closes a cycle that leaves this constant
// undefined at module load. `tests/forge/cutover-review.test.ts` pins it against
// `QUEUE_IN_FLIGHT_STATES` so the two cannot drift apart unnoticed.
export const CUTOVER_BLOCKING_STATES: readonly QueueItemState[] = ['planning', 'running', 'review'];

/** Whether nothing on the board would lose anything if the process restarted now. */
export function cutoverIdle(input: { items: QueueItem[]; queueBusy: boolean }): boolean {
  if (input.queueBusy) return false;
  return !input.items.some((item) => CUTOVER_BLOCKING_STATES.includes(item.state));
}

export interface CutoverCheckoutGit {
  /** `git fetch`, run before every comparison so a stale local ref (this machine has
   *  not fetched in a while) never reads as "nothing moved". */
  fetch(checkout: string): Promise<void>;
  /** The sha `origin/main` (or whichever ref this checkout tracks) currently points at,
   *  after the fetch above. */
  remoteHead(checkout: string, ref: string): Promise<string>;
  /** `git pull --ff-only`. Never called unless the caller is about to restart onto the
   *  result -- a cutover that is not due never touches the working tree. */
  pullFastForward(checkout: string): Promise<void>;
}

export interface CutoverDueInput {
  checkout: string;
  runningHead: string;
  /** True when nothing is in flight: no queue item in `planning`/`running`/a review
   *  round, no council round mid-way, no chain hop half done. The caller decides what
   *  "idle" means for its own fleet; this module only ever calls it once, right before
   *  deciding whether to act on a real diff. */
  idle: () => boolean;
  git: CutoverCheckoutGit;
  append: (event: Record<string, unknown>) => void;
  /** Defaults to `main` -- the branch every registered repo in this workspace treats as
   *  its trunk. A caller whose self-repo tracks a different default branch passes it
   *  explicitly rather than this module guessing at one. */
  ref?: string;
}

export interface CutoverDueResult {
  restart: boolean;
  from?: string;
  to?: string;
}

export async function cutoverDue(input: CutoverDueInput): Promise<CutoverDueResult> {
  const ref = input.ref ?? 'main';
  await input.git.fetch(input.checkout);
  const remoteHead = await input.git.remoteHead(input.checkout, ref);

  if (remoteHead === input.runningHead) return { restart: false };
  if (!input.idle()) return { restart: false };

  await input.git.pullFastForward(input.checkout);
  input.append({ event: 'self.restart', actor: 'self', from: input.runningHead, to: remoteHead });
  return { restart: true, from: input.runningHead, to: remoteHead };
}
