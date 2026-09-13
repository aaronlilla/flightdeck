import { useStore } from './store.js';
import { actionKey } from './actions.js';
import type { BoardCommand } from './laneVM.js';

/**
 * Whether a lane command clicked a moment ago is still in flight.
 *
 * Aaron, 2026-09-13: "if i click a button anywhere in the application i expect to feel
 * immediate feedback". Four places render a lane command -- the board tile, the
 * waiting-for-merge row, the blocked row, and the lane sheet's action bar -- and every one
 * of them called through and rendered nothing at all. A click sat there looking unpressed
 * until the next poll changed the row underneath it, which on a merge is several seconds
 * of a person wondering whether the button works.
 *
 * The pending state already exists: every action dispatches it the moment it is called,
 * keyed by the action's own id and the lane it was called on. Nothing on the board read
 * it. This is that read, so one hook serves every control rather than each growing its own
 * copy of the same state.
 */

/** Which catalog action a board command runs, matching `App.tsx`'s own dispatch. A
 *  command with no entry here runs no action -- navigation, or a link -- and never shows
 *  a busy state because nothing is in flight for it. */
const ACTION_FOR: Partial<Record<BoardCommand, string>> = {
  merge: 'mergeRun',
  resume: 'resumeRun',
  compact: 'compactRun',
  verify: 'verifyRun',
  reopen: 'reopenRun',
  unretire: 'unretireRun',
  recheck: 'recheckRun',
  kill: 'killRun',
  pause: 'pauseRun',
  retire: 'retireRun',
  reaudit: 'reauditRun',
};

/** The action a board command runs, or null for one that only navigates. Exported so a
 *  test can hold this table against `App.tsx`'s dispatch rather than trusting they agree. */
export function actionForCommand(cmd: BoardCommand): string | null {
  return ACTION_FOR[cmd] ?? null;
}

export function useCommandPending(laneId: string, cmd: BoardCommand): boolean {
  const { state } = useStore();
  const action = actionForCommand(cmd);
  if (!action) return false;
  return state.pending[actionKey(action, laneId)] !== undefined;
}

/**
 * Whether this command is waiting for the operator to confirm it.
 *
 * An irreversible command does not run on the click: the server proposes, and the person
 * confirms. On the board that proposal went only into the rail, so the button snapped
 * back to reading "Merge" within a fraction of a second while the question appeared
 * somewhere else on the screen (measured 2026-09-13: pressed Merge, read the label 350 ms
 * later, still "Merge", still not busy). The queue's own rows have always turned into
 * "Confirm merge" in place; the board never did.
 */
export function useCommandConfirming(laneId: string, cmd: BoardCommand): string | null {
  const { state } = useStore();
  const action = actionForCommand(cmd);
  if (!action) return null;
  const result = state.actions[actionKey(action, laneId)]?.result;
  return result?.kind === 'confirm' ? result.token : null;
}

/** What a button says while it is waiting to be confirmed. Names the command, so the
 *  second press is about the same thing the first one was. */
export function confirmLabelFor(cmd: BoardCommand, idle: string): string {
  return `Confirm ${idle.toLowerCase()}`;
}

/** What a button says while its command is in flight. The label is the command's own,
 *  in the continuous tense, so the button never changes into a different word -- a
 *  Merge that becomes "Working…" tells a reader less than one that becomes "Merging…". */
const BUSY_LABEL: Partial<Record<BoardCommand, string>> = {
  merge: 'Merging…',
  resume: 'Resuming…',
  compact: 'Compacting…',
  verify: 'Verifying…',
  reopen: 'Reopening…',
  unretire: 'Unretiring…',
  recheck: 'Re-checking…',
  kill: 'Stopping…',
  pause: 'Pausing…',
  retire: 'Retiring…',
  reaudit: 'Re-auditing…',
};

export function busyLabelFor(cmd: BoardCommand, idle: string): string {
  return BUSY_LABEL[cmd] ?? idle;
}
