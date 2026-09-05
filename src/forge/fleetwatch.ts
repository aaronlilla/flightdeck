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

export type ProcessProbe = { ok: true; lines: string[] } | { ok: false; reason: string };

/**
 * The first token after the pid: the executable a process line names, quoted or not.
 *
 * `undefined` when the line has nothing after the pid (a handful of system processes on
 * every machine this reads show up with a blank command).
 */
function executableOf(line: string): string | undefined {
  const rest = line.replace(/^\s*\d+\s*/, '');
  const quoted = /^"([^"]*)"/.exec(rest);
  if (quoted) return quoted[1] || undefined;
  const unquoted = /^(\S+)/.exec(rest);
  return unquoted?.[1];
}

/**
 * F1: a process counts only when its own executable is claude, not when `claude`
 * shows up anywhere on its command line.
 *
 * The old regex (`claude(\.exe)?\b` over the whole line, case-insensitive) matched a Git
 * Bash shell reading `.claude/shell-snapshots/...`, a script under a `Temp/claude/`
 * scratchpad, a PowerShell running `.claude/coordination/tile.ps1`, and a `nohup` wrapper
 * around an unrelated command: 26 false matches out of 29 on this machine, every one a
 * path or scratch directory with "claude" in it, none an actual claude process. The
 * basename of the first token after the pid is the only field worth trusting here: real
 * launches show up with and without a directory, with and without `.exe`, with and
 * without quotes, and `claude(.exe)? login` is still recognisable inside them.
 */
function isClaudeExecutable(line: string): boolean {
  const exe = executableOf(line);
  if (!exe) return false;
  const base = exe.split(/[\\/]/).pop() ?? exe;
  return /^claude(\.exe)?$/i.test(base);
}

/**
 * The process table, pid first on every platform, or why reading it failed.
 *
 * `wmic` is deprecated and gone from newer Windows images (verified absent on this
 * machine), so the win32 branch goes through PowerShell's CIM cmdlet instead. Both
 * branches are written pid-first on purpose: a command line ending in a number (a port, a
 * turn count) would otherwise be misread as the pid if the match tried the line's tail
 * first, which is what happened on POSIX when this used the same trailing-digit pattern
 * for both platforms.
 */
export function probeProcessList(): ProcessProbe {
  try {
    if (process.platform === 'win32') {
      const lines = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
      ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
      return { ok: true, lines };
    }
    const lines = execFileSync('ps', ['-eo', 'pid,args'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n');
    return { ok: true, lines };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Every line of the process table, pid first on every platform. Empty on a read failure.
 *
 * For a caller that only needs a best-effort list and has nothing sensible to do with a
 * failure reason (checking whether a `claude login` is in flight, feeding the cutover
 * warden). `watchedProcesses` below does not use this: liveness's stale-session signal is
 * exactly the case a silently empty list would hide.
 */
export function readProcessList(): string[] {
  const probe = probeProcessList();
  return probe.ok ? probe.lines : [];
}

/**
 * A claude process's kind, read from its command line alone: `login` (`claude login`),
 * `worker` (the SDK's own print-mode invocation, see below), `native-host` (the Chrome
 * extension's helper), or `interactive` (anything else, meaning one of Aaron's own
 * terminals).
 *
 * 2026-09-05: `forge status` reported three of Aaron's own processes as `STUCK
 * stale-session`, two interactive `claude.exe --dangerously-skip-permissions` terminals
 * and one `claude.exe --chrome-native-host`. None is a fleet worker, so none has a fleet
 * session file that can go stale. `watchedProcesses` handed all three to liveness shaped
 * exactly like a real worker (`isLogin: false` plus a `sessionFileMtime`), which is what
 * made them trip forever. `sdkengine.ts` spawns every real worker through the SDK's own
 * `query()`, whose transport always pushes `--output-format stream-json`
 * (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`'s `initialize()` builds that
 * flag pair unconditionally, before any model or permission option). No other launch of
 * `claude` on this machine has a reason to carry it, so its presence is the marker.
 */
export type ProcessKind = 'login' | 'worker' | 'native-host' | 'interactive';

function classifyClaudeLine(line: string): ProcessKind {
  if (/claude(\.exe)?\s+login/i.test(line)) return 'login';
  if (/--chrome-native-host\b/i.test(line)) return 'native-host';
  if (/--output-format\b/i.test(line)) return 'worker';
  return 'interactive';
}

/**
 * Every `claude` process on this machine, read from the process list: the fleet's workers
 * and its login, and Aaron's own interactive sessions and the Chrome native host, which
 * the caller must list and never act on. `{ ok: false, reason }` when the probe behind it
 * failed, rather than the empty list a failure used to produce -- liveness's stale-session
 * signal cannot tell a verified-clean fleet from a probe that never ran unless the two are
 * shaped differently.
 */
export function watchedProcesses(
  probe: ProcessProbe = probeProcessList(),
): FleetProcess[] | { ok: false; reason: string } {
  if (!probe.ok) return { ok: false, reason: probe.reason };
  const lines = probe.lines;
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

  const credentialsPath = join(fleetConfigDir(), '.credentials.json');
  const credentialsMtime = existsSync(credentialsPath) ? statSync(credentialsPath).mtimeMs : undefined;

  return lines
    .filter((line) => isClaudeExecutable(line))
    .map((line): FleetProcess | undefined => {
      const pidMatch = /^\s*(\d+)/.exec(line);
      const pid = pidMatch ? Number(pidMatch[1]) : NaN;
      if (!Number.isFinite(pid)) return undefined;
      const kind = classifyClaudeLine(line);
      if (kind === 'login') {
        return { pid, isLogin: true, kind, ...(credentialsMtime !== undefined ? { credentialsMtime } : {}) };
      }
      if (kind === 'worker') {
        return {
          pid, isLogin: false, kind,
          ...(latestSessionMtime !== undefined ? { sessionFileMtime: latestSessionMtime } : {}),
        };
      }
      // native-host, interactive: listed for visibility, never fed a session or
      // credentials mtime -- there is no fleet signal for `assess` to read either from.
      return { pid, isLogin: false, kind };
    })
    .filter((proc): proc is FleetProcess => Boolean(proc));
}
