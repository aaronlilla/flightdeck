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
