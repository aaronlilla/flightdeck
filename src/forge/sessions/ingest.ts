/**
 * What happens to a `POST /sessions/event` payload once it is authorized: journaled,
 * and — for an ending session that was not a clean, complete stop — cleaned up.
 *
 * Kept out of `server.ts` on purpose: this is the part with real branching (exit
 * classification, the cleanup fan-out), and it is the part `tests/forge/sessions/ingest.test.ts`
 * needs to drive without an HTTP server. `server.ts` wires this to `appendOnce`, the real
 * `coordlib.py sweep` and `git status`; a route test never has to fake HTTP to reach it.
 */
import type { ForgeEvent } from '../journal.js';
import { classifyExit, classifyVanished, type ExitClass, type SessionEndReason } from './exit.js';

export interface IncomingSessionEvent {
  event: string;
  session: string;
  cwd?: string;
  configDir?: string;
  reason?: SessionEndReason;
  closedWithComplete?: boolean;
  closeKind?: string;
  [key: string]: unknown;
}

export interface SweepResult {
  releasedLocks: string[];
}

export interface WorktreeStatus {
  path: string;
  clean: boolean;
  pushed: boolean;
}

export interface IngestDeps {
  append: (row: Partial<ForgeEvent>) => ForgeEvent;
  /** The session's most recent `session.stop`/`session.subagent-stop` row, if any. */
  lastStopFor: (sessionId: string) => { closedWithComplete: boolean } | undefined;
  /** `coordlib.py sweep` for exactly this session -- never reimplemented here (order 6). */
  sweep: (sessionId: string) => SweepResult;
  /** `undefined` when the session's cwd is not inside a worktree this machine knows about. */
  worktreeStatusFor: (sessionId: string, cwd: string | undefined) => WorktreeStatus | undefined;
}

export const SESSION_EVENT_KINDS = new Set([
  'session.started',
  'session.prompt',
  'session.stop',
  'session.subagent-stop',
  'session.ended',
  'session.vanished',
  'session.notification',
  /** `PostToolUse` matched on `SendMessage` only -- see `hooks/forge_report.py`. Journals
   *  `to`/`from`/`chars`, never the message text (item 4). */
  'message.sent',
]);

const TERMINAL_KINDS = new Set(['session.ended', 'session.vanished']);
const CLEANUP_CLASSES = new Set<ExitClass>(['killed', 'interrupted']);

function runCleanup(deps: IngestDeps, session: string, cwd: string | undefined, exitClass: ExitClass): ForgeEvent[] {
  const rows: ForgeEvent[] = [];
  const swept = deps.sweep(session);
  rows.push(deps.append({
    event: 'session.cleanup', actor: 'session', session,
    releasedLocks: swept.releasedLocks, exitClass,
  }));
  const worktree = deps.worktreeStatusFor(session, cwd);
  if (worktree) {
    rows.push(deps.append({
      event: 'worktree.left', actor: 'session', session,
      path: worktree.path, clean: worktree.clean, pushed: worktree.pushed,
    }));
  }
  return rows;
}

/** One incoming event: journaled, then -- for a terminal event whose exit class needs
 *  it -- cleaned up. Never deletes a worktree; `worktree.left` only ever reports. */
export function ingestOne(deps: IngestDeps, incoming: IncomingSessionEvent): ForgeEvent[] {
  if (!SESSION_EVENT_KINDS.has(incoming.event)) {
    throw new Error(`unknown session event kind: ${incoming.event}`);
  }
  const { event, session, ...rest } = incoming;
  const rows: ForgeEvent[] = [deps.append({ event, actor: 'session', session, ...rest })];

  if (!TERMINAL_KINDS.has(event)) return rows;

  const lastStop = deps.lastStopFor(session);
  const closedWithComplete = lastStop?.closedWithComplete ?? false;
  const exitClass: ExitClass = event === 'session.vanished'
    ? classifyVanished()
    : classifyExit((incoming.reason as SessionEndReason) ?? 'other', closedWithComplete);

  if (CLEANUP_CLASSES.has(exitClass)) {
    rows.push(...runCleanup(deps, session, incoming.cwd, exitClass));
  }
  return rows;
}

/** `POST /sessions/event`'s whole body: one object or an array of them, in order. */
export function ingest(deps: IngestDeps, body: IncomingSessionEvent | IncomingSessionEvent[]): ForgeEvent[] {
  const items = Array.isArray(body) ? body : [body];
  return items.flatMap((item) => ingestOne(deps, item));
}
