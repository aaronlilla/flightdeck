/**
 * The real process-table reader, and what a failed read looks like downstream.
 *
 * A process probe can throw (PowerShell missing, `ps` unavailable, a timeout). Before
 * this, that failure and a verified-empty machine both produced `[]`, so liveness's
 * stale-session signal could never tell "nothing running" from "the sensor is broken."
 */
import { describe, expect, it } from 'vitest';

import { watchedProcesses } from '../../src/forge/fleetwatch.js';

describe('watchedProcesses, given an injected probe', () => {
  it('reads real claude processes from a successful probe', () => {
    const result = watchedProcesses({
      ok: true,
      lines: ['111 claude --some-flag', '222 claude login', '333 unrelated-process'],
    });
    expect(Array.isArray(result)).toBe(true);
    const processes = result as Array<{ pid: number; isLogin: boolean }>;
    expect(processes.map((p) => p.pid).sort()).toEqual([111, 222]);
    expect(processes.find((p) => p.pid === 222)?.isLogin).toBe(true);
  });

  it('surfaces a failed probe as { ok: false, reason }, never an empty list', () => {
    const result = watchedProcesses({ ok: false, reason: 'powershell timed out' });
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'powershell timed out' });
  });
});

/**
 * F1: `watchedProcesses` matched paths, not executables.
 *
 * The old filter, `claude(\.exe)?\b` over the whole line, matched anything with "claude"
 * in it: a Git Bash shell reading a `.claude/shell-snapshots/` file, a script under a
 * `Temp/claude/` scratchpad, a PowerShell running `.claude/coordination/tile.ps1`, a
 * `nohup` wrapper. Shapes below are genericised from a real 444-line process table
 * captured on 2026-09-05, which had 29 lines matching that regex and only 3 real
 * `claude.exe` processes.
 */
describe('watchedProcesses: only the executable is claude, not any path containing it', () => {
  const noise = [
    '17728 "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -File "C:\\dev\\.claude\\coordination\\tile.ps1" -Watch',
    '51000 "C:\\Program Files\\Git\\usr\\bin\\bash.exe" C:/Users/x/AppData/Local/Temp/claude/C--dev/abc/scratchpad/wait-and-run.sh',
    '51072 "C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/x/.claude/shell-snapshots/snapshot-bash-1-a.sh"',
    '34812 "C:\\Program Files\\Git\\usr\\bin\\nohup.exe" python C:/dev/dev-harness/tools/codex_call.py --label run',
  ];
  const realClaude = [
    '35256 C:\\Users\\x\\.local\\bin\\claude.exe --dangerously-skip-permissions',
    '50664 "C:\\Users\\x\\.local\\bin\\claude.exe"  "--chrome-native-host"',
    '31120 C:\\Users\\x\\.local\\bin\\claude.exe --dangerously-skip-permissions',
  ];
  const posixClaude = '9001 /usr/local/bin/claude -p "some prompt"';
  const loginClaude = '9002 C:\\Users\\x\\.local\\bin\\claude.exe login';

  it('drops every noise line and keeps only the real claude executables', () => {
    const result = watchedProcesses({
      ok: true, lines: [...noise, ...realClaude, posixClaude],
    });
    const processes = result as Array<{ pid: number; isLogin: boolean }>;
    expect(processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([9001, 31120, 35256, 50664]);
  });

  it('still recognises a quoted claude.exe running login, flagged isLogin', () => {
    const result = watchedProcesses({ ok: true, lines: [loginClaude] });
    const processes = result as Array<{ pid: number; isLogin: boolean }>;
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ pid: 9002, isLogin: true });
  });

  it('never matches a path segment or scratchpad file merely containing "claude"', () => {
    const result = watchedProcesses({ ok: true, lines: noise });
    expect(result).toEqual([]);
  });
});
