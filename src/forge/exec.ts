/**
 * Commands the supervisor runs on a worker's behalf, under a clock it owns.
 *
 * A worker asked to run a build has no idea how long a build takes here, so a hang in the
 * command becomes a hang in the run, and the only evidence afterwards is that nothing
 * happened for an hour. The supervisor holds the budget instead: total wall time, and
 * time since the last byte of output. Either running out kills the command, writes a dump
 * with the tail, and returns that to the worker as a result it can act on.
 *
 * Killing is the part Windows makes easy to get wrong. `npm` spawns `node`, `gradle`
 * spawns `java`, and killing the process the supervisor started leaves those running: the
 * budget looks enforced while the machine stays busy. `taskkill /F /T` takes the tree.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Budget {
  /** Seconds of total run time. */
  wall: number;
  /** Seconds since the last byte of output. */
  idle: number;
}

/**
 * Budgets by what the command is, in seconds.
 *
 * Opinions about this machine rather than universal truths, which is why a call may
 * override its own and why the table is small enough to argue with. Carried over from
 * Forge Phase 1, where they were measured rather than guessed.
 */
export const CLASS_BUDGETS: Record<string, Budget> = {
  install: { wall: 600, idle: 120 },
  test: { wall: 900, idle: 300 },
  build: { wall: 1800, idle: 600 },
  script: { wall: 120, idle: 60 },
  goal: { wall: 7200, idle: 900 },
};

export const DEFAULT_CLASS = 'script';

/** How much of the output travels back with the result. */
export const TAIL_BYTES = 4000;

export function budgetsFor(cls: string, overrides: Partial<Budget> = {}): Budget {
  const base = CLASS_BUDGETS[cls] ?? CLASS_BUDGETS[DEFAULT_CLASS]!;
  return { wall: overrides.wall ?? base.wall, idle: overrides.idle ?? base.idle };
}

/**
 * End a process and everything it started.
 *
 * A no-op on a pid that has already gone: a command that finished a moment before its
 * budget expired is a race, not an error, and throwing here would turn a clean run into
 * a failure report.
 */
export function killTree(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      // Negative pid is the process group, which is the same idea by another name.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone, or never ours to kill. Either way there is nothing left to do.
  }
}

export interface RunRequest {
  argv: string[];
  cwd: string;
  /** The run this command belongs to. Names the log and the dump. */
  owner: string;
  cls?: string;
  wall?: number;
  idle?: number;
  env?: NodeJS.ProcessEnv;
  /** Where the log and dump go. Omitted means memory only. */
  logDir?: string;
}

export interface RunResult {
  owner: string;
  argv: string[];
  pid?: number;
  returncode: number | null;
  /** Which budget ran out, when one did. */
  killed?: 'wall' | 'idle';
  logPath?: string;
  dumpPath?: string;
  tail: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
}

function safeName(owner: string): string {
  return (owner || 'run').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Run a command to completion, or to the end of its budget.
 *
 * Resolves rather than rejects on every outcome, including a binary that does not exist.
 * A worker needs the failure as data it can read; an exception here would surface as the
 * supervisor breaking rather than the command failing, which sends the next reader to the
 * wrong file.
 */
export async function run(request: RunRequest): Promise<RunResult> {
  const budget = budgetsFor(request.cls ?? DEFAULT_CLASS, {
    ...(request.wall !== undefined ? { wall: request.wall } : {}),
    ...(request.idle !== undefined ? { idle: request.idle } : {}),
  });
  const startedAt = Date.now();

  let logPath: string | undefined;
  let dumpPath: string | undefined;
  if (request.logDir) {
    mkdirSync(request.logDir, { recursive: true });
    logPath = join(request.logDir, `${safeName(request.owner)}.log`);
    dumpPath = join(request.logDir, `${safeName(request.owner)}.dump.txt`);
  }
  const log = logPath ? createWriteStream(logPath, { flags: 'a' }) : undefined;

  const [command, ...args] = request.argv;
  const child = spawn(command!, args, {
    cwd: request.cwd,
    env: request.env ?? process.env,
    shell: false,
    // Its own group, so the negative-pid kill on POSIX has a group to take. On Windows
    // taskkill walks the tree from the pid and needs nothing here.
    detached: process.platform !== 'win32',
  });

  let buffer = '';
  let lastActivity = Date.now();
  const collect = (chunk: Buffer | string) => {
    const text = String(chunk);
    lastActivity = Date.now();
    buffer = (buffer + text).slice(-TAIL_BYTES);
    log?.write(text);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  return new Promise<RunResult>((resolve) => {
    let killed: 'wall' | 'idle' | undefined;
    let settled = false;

    // One timer for both budgets. A separate idle timer reset on every chunk would fire
    // thousands of times a second on a chatty build.
    const tick = setInterval(() => {
      const now = Date.now();
      if (now - startedAt > budget.wall * 1000) killed = 'wall';
      else if (now - lastActivity > budget.idle * 1000) killed = 'idle';
      if (killed && child.pid) killTree(child.pid);
    }, 250);

    const finish = (returncode: number | null) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      log?.end();

      const durationMs = Date.now() - startedAt;
      if (killed && dumpPath) {
        writeFileSync(dumpPath, [
          `owner: ${request.owner}`,
          `argv: ${request.argv.join(' ')}`,
          `cwd: ${request.cwd}`,
          `killed: ${killed} budget (wall ${budget.wall}s, idle ${budget.idle}s)`,
          `ran for: ${Math.round(durationMs / 1000)}s`,
          '',
          '--- last output ---',
          buffer,
        ].join('\n'), 'utf8');
      }

      resolve({
        owner: request.owner,
        argv: request.argv,
        ...(child.pid ? { pid: child.pid } : {}),
        returncode,
        ...(killed ? { killed } : {}),
        ...(logPath ? { logPath } : {}),
        ...(killed && dumpPath ? { dumpPath } : {}),
        tail: buffer,
        startedAt,
        durationMs,
        ok: !killed && returncode === 0,
      });
    };

    child.on('error', (error) => {
      // A binary that does not exist arrives here, not on stderr.
      collect(`${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Whether a dump exists for a run, which is what a reader wants after a kill. */
export function dumpFor(logDir: string, owner: string): string | undefined {
  const path = join(logDir, `${safeName(owner)}.dump.txt`);
  return existsSync(path) ? path : undefined;
}
