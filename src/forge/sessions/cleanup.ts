/**
 * The real cleanup a killed or interrupted session's `session.ended`/`session.vanished`
 * row triggers: `coordlib.py sweep` (never reimplemented, per order 6 -- this shells out
 * to the existing mechanism and reads what it printed) and a `git status` read on the
 * session's cwd, reported, never deleted.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { workspaceRoot } from '../paths.js';

export interface SweepResult {
  releasedLocks: string[];
}

const SWEPT_LINE = /^swept:\s*(.+)$/;

/** `<workspaceRoot>/.claude/coordination/coordlib.py` -- never a machine-rooted literal
 *  (this repository stays project- and machine-agnostic; `tests/checks/agnostic.ts` is
 *  the detector). `workspaceRoot()` already derives the parent of wherever `forge up`
 *  itself runs from, which is exactly where `.claude/coordination` lives. */
function coordlibPath(): string {
  return join(workspaceRoot(), '.claude', 'coordination', 'coordlib.py');
}

/** Runs the coordination registry's own sweep and returns the lock names it released
 *  (parsed from its own `swept: <path>` lines) -- global, not scoped to one session,
 *  because `coordlib.py sweep` has no session-scoped mode. Never throws: a sweep that
 *  fails to run reports nothing released rather than blocking the ingest route. */
export function sweepAndCollectLocks(pythonExe = 'python'): SweepResult {
  try {
    const out = execFileSync(pythonExe, [coordlibPath(), 'sweep'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const releasedLocks: string[] = [];
    for (const line of out.split('\n')) {
      const match = SWEPT_LINE.exec(line.trim());
      if (!match) continue;
      const path = match[1]?.replace(/\\/g, '/') ?? '';
      const lockMatch = /\/locks\/([^/]+)\.json$/.exec(path);
      if (lockMatch?.[1]) releasedLocks.push(lockMatch[1]);
    }
    return { releasedLocks };
  } catch {
    return { releasedLocks: [] };
  }
}

export interface WorktreeStatus {
  path: string;
  clean: boolean;
  pushed: boolean;
}

/** `undefined` when `cwd` is not inside a git worktree this machine can read. Never
 *  deletes anything -- reporting only, per the guardrail. */
export function worktreeStatusFor(_sessionId: string, cwd: string | undefined): WorktreeStatus | undefined {
  if (!cwd) return undefined;
  let path: string;
  try {
    path = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
  if (!path) return undefined;

  let clean = true;
  try {
    const status = execFileSync('git', ['-C', path, 'status', '--porcelain'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    clean = status.trim().length === 0;
  } catch {
    clean = false;
  }

  let pushed = true;
  try {
    const ahead = execFileSync('git', ['-C', path, 'rev-list', '@{u}..HEAD', '--count'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    pushed = ahead === '0';
  } catch {
    // No upstream configured reads as not pushed -- a branch nobody can see on GitHub
    // is exactly the case `worktree.left` exists to surface.
    pushed = false;
  }

  return { path, clean, pushed };
}
