/**
 * The `session.started` journal row built from one `scanSessions` row. Pulled out of
 * `cli.ts`'s 30 s tick so item 1's pid plumbing has something a unit test can call
 * directly, rather than asserting on the tick's side effects.
 */
import type { SessionRow } from './registry.js';

export interface SessionStartedRow {
  event: 'session.started';
  actor: 'registry';
  session: string;
  cwd: string;
  configDir: string;
  pid: number;
  repo?: string;
  worktree?: string;
  branch?: string;
  name: string;
  [key: string]: unknown;
}

export function sessionStartedRow(row: SessionRow): SessionStartedRow {
  return {
    event: 'session.started',
    actor: 'registry',
    session: row.sessionId,
    cwd: row.cwd,
    configDir: row.configDir,
    pid: row.pid,
    ...(row.repo ? { repo: row.repo } : {}),
    ...(row.worktree ? { worktree: row.worktree } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    name: row.name,
  };
}
