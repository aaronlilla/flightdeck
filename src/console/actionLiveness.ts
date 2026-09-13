import type { Lane, QueueItem } from '../shared/console-model.js';
import { LIVE, dead, type Liveness } from '../shared/liveness.js';

/**
 * Whether the button on a lane tile or a queue row would still do anything.
 *
 * These were the last two kinds in `LIVENESS_RULES` carrying a rule and no seam. A card
 * with a stated rule and nothing enforcing it is exactly the shape of the problem the
 * rules table exists to stop, which is why the table records the seam and the coverage
 * test names every `null` out loud.
 *
 * What this catches, in the words Aaron used: a board that is "constantly dead or old
 * information". A tile offering Merge on a pull request that merged an hour ago is not a
 * broken button, it is the board telling somebody to do a thing that is already done.
 *
 * Two notes on what is deliberately NOT dead here. `Resume` on a lane with no process is
 * live: resuming relaunches from scratch, so the absence of a process is the reason to
 * press it rather than a reason it would fail. And navigation — Watch, Open queue, Open
 * blockers, Fix in Settings — is always live, because moving to another screen cannot
 * fail on stale data.
 */

/** The commands `boardCta` can hand back that only move the reader somewhere. */
const NAVIGATION = new Set(['watch', 'settings', 'blockers', 'queue']);

export interface LaneActionInput {
  lane: Lane;
  /** The command `boardCta` chose, e.g. `merge`, `resume`, `recheck`. */
  cmd: string;
}

/**
 * A lane tile's own button.
 *
 * `merge` is the one that goes stale on its own, because the pull request behind it moves
 * on GitHub without the board being told. Everything else is decided by lane state the
 * board itself owns.
 */
export function laneActionLiveness(input: LaneActionInput): Liveness {
  const { lane, cmd } = input;
  const base = cmd.startsWith('open-url:') ? 'open-url' : cmd;
  if (base === 'open-url' || NAVIGATION.has(base)) return LIVE;

  if (lane.retiredAt !== null && lane.retiredAt !== undefined) {
    // Only Unretire makes sense for a lane that has left the board.
    return base === 'unretire' ? LIVE : dead('this lane has left the board');
  }

  if (base === 'merge') {
    if (lane.pr === null) return dead('no pull request is open on it');
    if (lane.pr.merged === true) return dead('its pull request is already merged');
    if (lane.mergeable?.ok === false) return dead(lane.mergeable.why);
    return LIVE;
  }

  if (base === 'pause') {
    // Pausing holds a running worker. Nothing is running, nothing to hold.
    if (lane.state !== 'running') return dead(`it is ${lane.state}, not running`);
    return lane.live?.alive === false ? dead('nothing is running for it to hold') : LIVE;
  }

  if (base === 'retire') {
    // Retiring takes a lane off the board. Doing it under a live worker loses the work in
    // flight, so the running lane is stopped first and this says so rather than refusing
    // silently.
    return lane.live?.alive === true ? dead('it is still running; stop it first') : LIVE;
  }

  if (base === 'kill') {
    // Killing stops a process. With none running there is nothing to stop, and the sweep
    // takes the lane off the board on its own (`forge/console/abandoned.ts`).
    return lane.live?.alive === false ? dead('nothing is running for it to stop') : LIVE;
  }

  // Resume, Re-check, Answer, Nudge, Unretire: each acts on board state rather than on
  // something that can vanish underneath it.
  return LIVE;
}

/**
 * A queue row's own button.
 *
 * The row is read from a list the store just answered with, so the row existing is not in
 * question. What goes stale is its state: a Merge offered on an item that has already
 * merged, or a Retry on one that is running again.
 */
export function queueActionLiveness(item: QueueItem, cmd: string): Liveness {
  if (cmd === 'merge') {
    if (item.state !== 'review') return dead(`it is ${item.state}, not waiting to merge`);
    if (item.pr?.merged === true) return dead('its pull request is already merged');
    return LIVE;
  }
  if (cmd === 'retry') {
    if (item.state === 'running' || item.state === 'planning') return dead('it is already working');
    if (item.state === 'done') return dead('it has finished');
    return LIVE;
  }
  if (cmd === 'remove') {
    return item.state === 'running' ? dead('it is running; stop it before removing it') : LIVE;
  }
  return LIVE;
}
