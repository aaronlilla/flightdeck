import type { LaneRecord } from './types.js';

const RUN_STATE_LABEL: Record<string, string> = {
  started: 'running',
  paused: 'paused',
  parked: 'blocked',
  'handed-off': 'handing-off',
};

/**
 * The one function that decides what a lane tile's pill says and what the command
 * bar counts it as. Shared rather than duplicated: X5's own genchi genbutsu against
 * a real seeded server caught the two disagreeing -- a tile could read "running"
 * from a live `run_state` while the command bar's own count, built from a
 * different, column-only check, still called the same lane "blocked" and reported
 * zero running lanes on a screen showing one running tile.
 */
export function stateOf(lane: LaneRecord): string {
  // X1: a live run wins over the lane's own verdict/column, which describe whichever
  // chain last finished rather than what is running right now. `finished` falls through
  // deliberately -- once a run is done, the lane's own verdict is the more informative
  // label (`done`, `failed`, and so on) than a bare "finished".
  if (lane.run_state && lane.run_state in RUN_STATE_LABEL) return RUN_STATE_LABEL[lane.run_state]!;
  if (lane.needs_aaron) return 'blocked';
  if (lane.verdict) return lane.column === 'blocked' ? 'blocked' : lane.verdict;
  if (lane.column) return lane.column;
  return 'running';
}

export type LaneCategory = 'running' | 'blocked' | 'done';

/**
 * The three buckets the command bar counts. Separate from `stateOf`'s exact pill
 * text (a finished lane's pill can read "passed" or "failed", which is neither
 * "done" nor a category name), and built the same way `stateOf` is: a live
 * `run_state` overrides a stale `column`/`verdict`, which is what a real seeded
 * server caught this cut missing (X5) -- the same lane read "running" on its own
 * tile and "blocked" in the command bar's count, because the count checked
 * `lane.column` directly and never looked at `run_state` at all.
 */
export function categoryOf(lane: LaneRecord): LaneCategory {
  if (lane.run_state === 'started' || lane.run_state === 'paused' || lane.run_state === 'handed-off') {
    return 'running';
  }
  if (lane.run_state === 'parked') return 'blocked';
  if (lane.needs_aaron) return 'blocked';
  if (lane.column === 'blocked') return 'blocked';
  if (lane.column === 'done') return 'done';
  return 'running';
}
