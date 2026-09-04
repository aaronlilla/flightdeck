/**
 * The real readers `forge up` hands to liveness: a process list and a clock.
 *
 * Kept out of `liveness.ts` on purpose, so that file never imports `node:child_process`
 * and a specimen there can never accidentally reach a real process. This is the only
 * place that does.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { FleetProcess } from './liveness.js';
import { fleetConfigDir } from './paths.js';

/** Every line of the process table, one process per line. Empty on a read failure. */
export function readProcessList(): string[] {
  try {
    if (process.platform === 'win32') {
      return execFileSync('wmic', ['process', 'get', 'ProcessId,CommandLine'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n');
    }
    return execFileSync('ps', ['-eo', 'pid,args'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n');
  } catch {
    return [];
  }
}

/**
 * Every `claude` process on this machine, read from the process list: the fleet's workers
 * and its login, and Aaron's own interactive sessions, which the caller must list and
 * never act on.
 */
export function watchedProcesses(lines: string[] = readProcessList()): FleetProcess[] {
  const sessionsDir = join(fleetConfigDir(), 'projects');
  const latestSessionMtime = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).reduce<number | undefined>((latest, name) => {
      try {
        const mtime = statSync(join(sessionsDir, name)).mtimeMs;
        return latest === undefined || mtime > latest ? mtime : latest;
      } catch {
        return latest;
      }
    }, undefined)
    : undefined;

  return lines
    .filter((line) => /claude(\.exe)?\b/i.test(line))
    .map((line): FleetProcess | undefined => {
      const pidMatch = /(\d+)\s*$/.exec(line.trim()) ?? /^\s*(\d+)/.exec(line);
      const pid = pidMatch ? Number(pidMatch[1]) : NaN;
      if (!Number.isFinite(pid)) return undefined;
      const isLogin = /claude(\.exe)?\s+login/i.test(line);
      return isLogin
        ? { pid, isLogin: true }
        : { pid, isLogin: false, ...(latestSessionMtime !== undefined ? { sessionFileMtime: latestSessionMtime } : {}) };
    })
    .filter((proc): proc is FleetProcess => Boolean(proc));
}
