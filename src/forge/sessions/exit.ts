/**
 * What a session's exit means, from `SessionEnd.reason` and whether its last `Stop`
 * closed with order 12's literal sentence. A `vanished` row (the process disappeared
 * with no `SessionEnd` in the same tick) is `killed` regardless of reason -- there was
 * no chance for the hook to report one.
 *
 * `closed_with_complete` is never inferred from anything but that literal substring
 * (see `hooks/forge_report.py`). Hardcoding this classifier to always read `done` is
 * exactly the failure the ten-combination test below is built to catch.
 */
export type SessionEndReason = 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other';

export type ExitClass = 'done' | 'abandoned' | 'continuing' | 'interrupted' | 'unknown' | 'killed';

export function classifyExit(reason: SessionEndReason, closedWithComplete: boolean): ExitClass {
  switch (reason) {
    case 'logout':
      return 'done';
    case 'clear':
      return closedWithComplete ? 'done' : 'abandoned';
    case 'resume':
      return 'continuing';
    case 'prompt_input_exit':
      return closedWithComplete ? 'done' : 'interrupted';
    case 'other':
      return closedWithComplete ? 'done' : 'unknown';
    default:
      return 'unknown';
  }
}

/** A `vanished` row with no matching `session.ended` in the same reconciliation tick. */
export function classifyVanished(): ExitClass {
  return 'killed';
}
