/**
 * The real cleanup a killed or interrupted session's `session.ended`/`session.vanished`
 * row triggers: `coordlib.py sweep` (never reimplemented, per order 6 -- this shells out
 * to the existing mechanism and reads what it printed) and a `git status` read on the
 * session's cwd, reported, never deleted.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { run as defaultExecRun, type RunRequest, type RunResult } from '../exec.js';
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

/**
 * Async twin of `worktreeStatusFor`, for the one caller that runs on an HTTP request path
 * at scale: the code-sync worktree sweep (`sync/code/real-deps.ts`), which probes ~90
 * worktrees across every checkout. Each git read goes through `exec.ts`'s spawn-based
 * `run` (non-blocking) instead of `execFileSync` (which froze the whole Node event loop
 * for the length of the sweep -- the specimen behind `operator-experience.md` §10). The
 * synchronous version below stays for the session-ingest path, which touches one terminal
 * session at a time, not a full-tree sweep.
 */
export async function worktreeStatusForAsync(
  _sessionId: string,
  cwd: string | undefined,
  execRun: (request: RunRequest) => Promise<RunResult> = defaultExecRun,
): Promise<WorktreeStatus | undefined> {
  if (!cwd) return undefined;

  const git = async (dir: string, rest: string[]): Promise<string | undefined> => {
    const result = await execRun({
      argv: ['git', '-C', dir, ...rest], cwd: dir, owner: 'worktree-status', cls: 'script',
      raw: true, fullOutput: true, wall: 20,
    });
    if (!result.ok) return undefined;
    return (result.full ?? result.tail).trim();
  };

  const path = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!path) return undefined;

  const status = await git(path, ['status', '--porcelain']);
  const clean = status !== undefined && status.length === 0;

  const ahead = await git(path, ['rev-list', '@{u}..HEAD', '--count']);
  // A missing upstream (git errors, `ahead` undefined) reads as not pushed -- a branch
  // nobody can see on GitHub is exactly what `worktree.left` exists to surface.
  const pushed = ahead === '0';

  return { path, clean, pushed };
}

/** `undefined` when `cwd` is not inside a git worktree this machine can read. Never
 *  deletes anything -- reporting only, per the guardrail. Synchronous: kept for the
 *  session-ingest path (`sessions/ingest.ts`), one terminal session at a time. The
 *  request-path sweep uses `worktreeStatusForAsync` above instead. */
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
