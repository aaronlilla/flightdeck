import type { Lane, QueueItem } from '../../shared/console-model.js';
import { abandonedVerdict, type WorktreeState } from './abandoned.js';

/**
 * The pass that lets an abandoned lane leave the board without anybody being asked.
 *
 * Aaron, 2026-09-12: "if a lane is stuck it needs to self heal ... what would my options
 * even be? leave it and just let it hold up the entire system? what a useless question."
 *
 * Everything that decides WHETHER a lane may go lives in `abandoned.ts` and is a pure
 * function. This is the part that has to touch the world: read each lane's worktree, and
 * write the retirement. Keeping the two apart is what makes the decision testable without
 * a filesystem, and it is why the decision has fifteen cases behind it and this has four.
 */

export interface AbandonedSweepDeps {
  /** The archived-inclusive lanes view, so a lane already gone is seen and skipped. */
  lanesAll: () => Lane[];
  /** Every queue item the store holds. */
  queue: () => readonly QueueItem[];
  /** This lane's worktree, or null when it could not be read — which counts as unsafe. */
  worktreeFor: (lane: Lane) => WorktreeState | null;
  /** Retires it and records why. */
  retire: (id: string, why: string) => void;
  now?: () => number;
  /** Told about every lane that STAYED and what kept it, so a lane holding the board can
   *  say so rather than sitting there unexplained. */
  onKept?: (lane: Lane, keptBecause: string) => void;
}

export interface AbandonedSweepResult {
  cleared: Array<{ id: string; why: string }>;
  kept: Array<{ id: string; keptBecause: string }>;
}

/**
 * One pass. Every lane is judged on its own, and one that throws while its worktree is
 * being read counts as unreadable — which keeps it, rather than taking the sweep down or
 * clearing it on a guess.
 */
export function sweepAbandonedLanes(deps: AbandonedSweepDeps): AbandonedSweepResult {
  const now = (deps.now ?? Date.now)();
  const queue = deps.queue();
  const result: AbandonedSweepResult = { cleared: [], kept: [] };

  for (const lane of deps.lanesAll()) {
    let worktree: WorktreeState | null;
    try {
      worktree = deps.worktreeFor(lane);
    } catch {
      worktree = null;
    }
    const verdict = abandonedVerdict({ lane, now, queue, worktree });
    if (!verdict.abandoned) {
      // A lane already off the board is not "kept" in any sense a person cares about.
      if (lane.retiredAt === null || lane.retiredAt === undefined) {
        result.kept.push({ id: lane.id, keptBecause: verdict.keptBecause });
        deps.onKept?.(lane, verdict.keptBecause);
      }
      continue;
    }
    try {
      deps.retire(lane.id, verdict.why);
      result.cleared.push({ id: lane.id, why: verdict.why });
    } catch {
      // A failed write is not a cleared lane: it stays, and the next pass tries again.
      result.kept.push({ id: lane.id, keptBecause: 'it could not be written off the board' });
    }
  }
  return result;
}
