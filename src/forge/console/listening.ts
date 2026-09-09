/**
 * Whether a run can actually receive a message right now. `/send` and the Conductor
 * agent's `send_to_run` tool both call this before writing to `RunInbox` -- W1's fix for
 * a message delivered to a dead lane's inbox with no reply and no error (the mission,
 * 2026-09-08). "Live" is the same `heart` field the board already renders: `true` for a
 * running lane, and for a handed-off lane whose chain still has a live process behind
 * it somewhere, per `lanes.ts`. A run absent from the lanes view entirely -- nothing on
 * the board has ever heard of it -- is refused the same way as one with a record and no
 * heart, since both mean nobody is listening.
 */
import type { LanesResponse } from '../../shared/console-model.js';

export type ListeningVerdict =
  | { listening: true }
  | { listening: false; reason: string };

export function assertRunListening(run: string, lanesView: () => LanesResponse): ListeningVerdict {
  const lane = lanesView().lanes.find((candidate) => candidate.id === run);
  if (!lane) {
    return {
      listening: false,
      reason: `${run} has no live session; nothing on the board runs it. Kill, verify or archive it instead.`,
    };
  }
  if (!lane.heart) {
    const ended = lane.endedAt ? new Date(lane.endedAt).toISOString() : 'earlier';
    return {
      listening: false,
      reason: `${run} has no live session; it ended ${ended}. Kill, verify or archive it instead.`,
    };
  }
  return { listening: true };
}
