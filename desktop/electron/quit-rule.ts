/**
 * What quitting the app does to the server it may or may not have started.
 *
 * Never stop a server this app attached to; it belongs to whoever started
 * it. When this app started the server, stop it only if nothing is live,
 * because a run in flight is real spend and real work that a quit must not
 * throw away.
 */
export type QuitAction =
  | { kind: 'stop-server-and-quit' }
  | { kind: 'leave-server-and-quit'; reason: 'attached' | 'run-live' };

export function decideQuitAction(startedByThisApp: boolean, hasLiveRun: boolean): QuitAction {
  if (!startedByThisApp) return { kind: 'leave-server-and-quit', reason: 'attached' };
  if (hasLiveRun) return { kind: 'leave-server-and-quit', reason: 'run-live' };
  return { kind: 'stop-server-and-quit' };
}
