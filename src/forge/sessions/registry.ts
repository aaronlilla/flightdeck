/**
 * Every session on the machine, from every config dir there is -- not just the two
 * fixed ones. flightdeck's own workers live under `~/.claude-fleet`; Aaron's terminals
 * under `~/.claude`; and any other Claude account connected through Forge's own
 * account registry (`~/.forge/accounts/registry.json`) has a `configDir` of its own.
 * Missing that third source is exactly how a fleet-account session goes invisible to
 * the orchestrator (see `tests/forge/sessions/registry.test.ts`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { accountsRegistryPath, loadAccounts } from '../accounts.js';

export interface SessionRow {
  sessionId: string;
  pid: number;
  configDir: string;
  accountLabel: string;
  cwd: string;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  kind: string;
  name: string;
  status: string;
  startedAt: number | string | undefined;
  statusUpdatedAt: number | string | undefined;
  messagingSocketPath?: string;
  transcriptPath?: string;
  vanished?: boolean;
}

export interface ConfigDirEntry {
  dir: string;
  accountLabel: string;
}

export interface GitInfo {
  repo: string | null;
  worktree: string | null;
  branch: string | null;
}

export interface RegistryDeps {
  /** The two fixed dirs. Overridable so a specimen never touches the real home. */
  fixedConfigDirs?: () => ConfigDirEntry[];
  /** Path fed to `loadAccounts` for the registry-derived dirs. */
  accountsRegistryPath?: string;
  readSessionFiles?: (dir: string) => Record<string, unknown>[];
  /** `undefined`/`null` when the pid is dead. When alive: the live process's start-time
   *  token if the probe knows it (then a differing `procStart` on the record means the pid
   *  was recycled and the session is gone), or `true` for a liveness-only answer that
   *  makes no claim about start time and is never compared to `procStart`. */
  probeAlivePid?: (pid: number) => number | string | true | null | undefined;
  gitInfo?: (cwd: string) => GitInfo;
}

/** The default liveness probe: `process.kill(pid, 0)` sends no signal, it only asks the
 *  OS whether the pid exists (OpenProcess on win32), throwing when it does not. It cannot
 *  see the process's start time, so it answers `true`, never a start-time token -- the
 *  2026-09-10 escape was this probe answering with a sentinel that `scanSessions` then
 *  compared to the record's `procStart`, marking every live session vanished each tick. */
export function probeAlivePidLiveness(pid: number): true | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return undefined;
  }
}

function defaultFixedConfigDirs(): ConfigDirEntry[] {
  return [
    { dir: join(homedir(), '.claude'), accountLabel: 'default' },
    { dir: join(homedir(), '.claude-fleet'), accountLabel: 'fleet' },
  ];
}

/** The two fixed dirs plus one per `provider: claude` entry in the accounts registry.
 *  A `provider: codex` entry is a different harness's session files and never belongs
 *  here -- this is the detector: a hardcoded two-dir list passes every fixed-dir case
 *  and silently drops any fleet-account session. */
function resolveConfigDirs(deps: RegistryDeps): ConfigDirEntry[] {
  const fixed = (deps.fixedConfigDirs ?? defaultFixedConfigDirs)();
  const accounts = loadAccounts(deps.accountsRegistryPath ?? accountsRegistryPath());
  const fromRegistry = accounts
    .filter((account) => account.provider === 'claude')
    .map((account): ConfigDirEntry => ({ dir: account.configDir, accountLabel: account.label || account.id }));
  // Aaron's own login is both a fixed dir and an accounts-registry entry, so the same
  // sessions dir was read twice and every session in it came back as two rows -- which
  // the registry tick then journaled as two identical `session.started` rows. First
  // entry wins, so a fixed dir keeps its fixed label.
  const seen = new Set<string>();
  const dirs: ConfigDirEntry[] = [];
  for (const entry of [...fixed, ...fromRegistry]) {
    const key = resolve(entry.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(entry);
  }
  return dirs;
}

function defaultReadSessionFiles(dir: string): Record<string, unknown>[] {
  const sessionsDir = join(dir, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name): Record<string, unknown> | null => {
      try {
        return JSON.parse(readFileSync(join(sessionsDir, name), 'utf8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => record !== null);
}

const gitInfoCache = new Map<string, GitInfo>();

/** `repo`/`worktree`/`branch` from `cwd`, cached per cwd -- never re-shelled out to git
 *  on every 30 s tick, only the first time a given cwd is seen. */
function defaultGitInfo(cwd: string): GitInfo {
  const cached = gitInfoCache.get(cwd);
  if (cached) return cached;
  let repo: string | null = null;
  let branch: string | null = null;
  try {
    repo = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim() || null;
  } catch {
    repo = null;
  }
  if (repo) {
    try {
      branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
      }).trim() || null;
    } catch {
      branch = null;
    }
  }
  const info: GitInfo = { repo, worktree: repo, branch };
  gitInfoCache.set(cwd, info);
  return info;
}

/** Test seam: forget cached git lookups between specimens. */
export function resetGitInfoCache(): void {
  gitInfoCache.clear();
}

/** Every session record across every config dir, each checked against the live process
 *  table. A record whose pid is gone (or whose `procStart` no longer matches a live pid
 *  reusing the number) comes back with `vanished: true` rather than being dropped -- the
 *  caller journals `session.vanished` for exactly that row. */
export function scanSessions(deps: RegistryDeps = {}): SessionRow[] {
  const readSessionFiles = deps.readSessionFiles ?? defaultReadSessionFiles;
  const probeAlivePid = deps.probeAlivePid ?? (() => undefined);
  const gitInfo = deps.gitInfo ?? defaultGitInfo;

  const rows: SessionRow[] = [];
  for (const { dir, accountLabel } of resolveConfigDirs(deps)) {
    for (const record of readSessionFiles(dir)) {
      const pid = Number(record['pid']);
      const cwd = typeof record['cwd'] === 'string' ? record['cwd'] : '';
      const live = Number.isFinite(pid) ? probeAlivePid(pid) : undefined;
      const recordedProcStart = record['procStart'];
      // A `true` answer is liveness only: the probe saw the pid but not its start time, so
      // there is nothing to hold `procStart` against. Only a probe that returns a token
      // can detect a recycled pid.
      const vanished = live === undefined || live === null
        || (live !== true && recordedProcStart !== undefined && String(live) !== String(recordedProcStart));
      const git = cwd ? gitInfo(cwd) : { repo: null, worktree: null, branch: null };
      rows.push({
        sessionId: String(record['sessionId'] ?? ''),
        pid,
        configDir: dir,
        accountLabel,
        cwd,
        repo: git.repo,
        worktree: git.worktree,
        branch: git.branch,
        kind: typeof record['kind'] === 'string' ? record['kind'] : 'interactive',
        name: typeof record['name'] === 'string' ? record['name'] : String(record['sessionId'] ?? ''),
        status: typeof record['status'] === 'string' ? record['status'] : 'idle',
        startedAt: record['startedAt'] as number | string | undefined,
        statusUpdatedAt: record['statusUpdatedAt'] as number | string | undefined,
        messagingSocketPath: record['messagingSocketPath'] as string | undefined,
        transcriptPath: record['transcriptPath'] as string | undefined,
        ...(vanished ? { vanished: true } : {}),
      });
    }
  }
  return rows;
}
