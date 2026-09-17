import type { Lane, QueueItem } from '../../shared/console-model.js';

/**
 * A lane with nothing alive behind it clears itself.
 *
 * Aaron, 2026-09-12: "if a lane is stuck it needs to self heal, if that means killing
 * something is necessary to continue then do it. what would my options even be? leave it
 * and just let it hold up the entire system? what a useless question."
 *
 * He is right that the question was useless, and the reason is sharper than the wording.
 * Three lanes sat `blocked` for 70, 72 and 83 hours. All three had no process
 * (`live.alive === false`, no pid), no queue row, and a worktree that was clean and fully
 * pushed or absent entirely. The console offered exactly one exit for each: Kill, which
 * is irreversible and therefore raises a confirm card. So the board asked, every ten
 * minutes, whether to destroy something that had already been destroyed.
 *
 * `retireEligible` refused them because it requires `laneFinished`, and a lane that died
 * without journaling `run.finished` stays `blocked` forever. That is the trap its own
 * comment describes: "the card could never leave the board".
 *
 * **Kill is the wrong verb, which is why no confirm is needed.** Nothing is running, so
 * there is nothing to stop. Retiring is the reversible action — the lane keeps its
 * history, `GET /lanes?archived=1` still finds it, and one more row brings it back — so
 * an abandoned lane is retired, not killed, and destroys nothing by construction.
 *
 * The warden's standing rule that it never kills (`warden-tick.ts`: "a kill needs a
 * `decision.made` row a person wrote") is intact. This does not kill. It is narrower than
 * that rule, and the reason behind the rule — an automated loop must never destroy work in
 * flight — is met twice over: the lane must have no live process AND no queue row, and
 * retiring deletes nothing even if both checks were somehow wrong.
 */

/** How long a lane must have been silent before its silence counts as abandonment.
 *
 *  Generous on purpose. A process can stop reporting for a minute without being gone, and
 *  the cost of waiting is a stale card while the cost of being wrong is a lane leaving the
 *  board while somebody is working in it. The three found live had been silent for 70
 *  hours; half an hour is far past any pause a working run takes. */
export const ABANDONED_SILENCE_MS = 30 * 60_000;

/** What the worktree behind a lane holds. Answered by the caller, which is the only
 *  thing that can run git. */
export interface WorktreeState {
  /** False when the directory is not there at all — nothing to lose. */
  exists: boolean;
  /** Any tracked or untracked change not committed. */
  dirty: boolean;
  /** Any commit not on its upstream. A branch with no upstream counts as unpushed. */
  unpushed: boolean;
}

/**
 * Whether letting this lane off the board would hide work somebody still wants to see.
 *
 * NOT a safety gate, and the first draft of this file had it wrong. Retiring writes one
 * row to `retired.jsonl`; it does not touch a working tree, a branch or a file. Only
 * `kill` removes a worktree. So a worktree the sweep could not read cannot be lost by
 * retiring the lane, and treating unknown as unsafe would have kept every lane whose
 * registry row was already gone -- which is every lane this exists to clear.
 *
 * What the check is for instead: a tree carrying uncommitted or unpushed work represents
 * something unfinished, and taking its lane off the board makes that harder to notice. A
 * lane like that stays, as a courtesy to whoever left the work there. Unknown does not
 * get that courtesy, because there is nothing to be courteous about.
 */
export function worktreeIsSafeToLeave(state: WorktreeState | null): boolean {
  if (state === null) return true;
  if (!state.exists) return true;
  return !state.dirty && !state.unpushed;
}

export interface AbandonedInput {
  lane: Lane;
  now: number;
  /** Every queue item the store still holds. A row still owning this lane means the
   *  pipeline has not finished with it, whatever the process is doing. */
  queue: readonly QueueItem[];
  /** The state of this lane's worktree, or null when it could not be read. */
  worktree: WorktreeState | null;
}

export type AbandonedVerdict =
  | { readonly abandoned: true; readonly why: string }
  | { readonly abandoned: false; readonly keptBecause: string };

/**
 * Whether this lane can leave the board on its own.
 *
 * Every `false` carries the reason, because a lane that stays needs to say why it stayed
 * — that reason is what the card shows a person instead of a generic ask.
 */
export function abandonedVerdict(input: AbandonedInput): AbandonedVerdict {
  const { lane, now, queue, worktree } = input;

  if (lane.retiredAt !== null && lane.retiredAt !== undefined) {
    return { abandoned: false, keptBecause: 'it has already left the board' };
  }

  // Something is running. This is the condition the warden's no-kill rule exists for, and
  // it is checked first so the rest can never reach a live run.
  if (lane.live?.alive !== false) {
    return { abandoned: false, keptBecause: 'a process is still running for it' };
  }

  const lastEventAt = lane.live?.lastEventAt ?? lane.since ?? 0;
  const silentFor = now - lastEventAt;
  if (silentFor < ABANDONED_SILENCE_MS) {
    return { abandoned: false, keptBecause: 'it went quiet too recently to call it gone' };
  }

  // A queue row still owning it means the pipeline expects to do something with it: the
  // retry, the merge and the handoff all run off that row.
  const owner = queue.find((item) => item.runKey === lane.id);
  if (owner) {
    return { abandoned: false, keptBecause: `the queue still holds it at ${owner.state}` };
  }

  if (!worktreeIsSafeToLeave(worktree)) {
    const detail = worktree!.dirty && worktree!.unpushed ? 'its worktree has uncommitted and unpushed work'
      : worktree!.dirty ? 'its worktree has uncommitted work'
        : 'its worktree has commits that were never pushed';
    return { abandoned: false, keptBecause: detail };
  }

  const hours = Math.round(silentFor / 3_600_000);
  const where = worktree === null ? 'no worktree is on record for it'
    : worktree.exists ? 'its worktree is clean and pushed' : 'its worktree is gone';
  return {
    abandoned: true,
    why: `no process, nothing in the queue, silent ${hours}h, and ${where}`,
  };
}
