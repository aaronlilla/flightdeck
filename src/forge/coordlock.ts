/**
 * B.7: Forge honouring the workspace's own multi-session coordination locks -- one JSON
 * file per held lock under the coordination root's own `locks/` directory, read by
 * `coordlib.py` and its guard.
 *
 * `coordlib.py`'s liveness rule reads a lock's holder against the harness's own record at
 * `~/.claude/sessions/<pid>.json`: live iff that file exists for the lock's `pid` and both
 * its `sessionId` and `procStart` match what the lock recorded. A Forge worker is not an
 * interactive Claude session and gets no such file from anything else, so a Forge-held
 * lock would read EXPIRED (and be stolen) the instant any other coordinated session looked
 * at it, unless Forge writes that record for itself. This is that write, plus the lock
 * file itself, in coordlib's exact schema, so a Forge lock and a session's lock are
 * indistinguishable to the guard.
 *
 * Deliberately narrow: only the lock names Forge has any real use for. `rn-dev-loop`
 * covers the one physical device, the bundler and the mock, worktrees only -- Forge never
 * runs there and never asks for it.
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Matches `coordlib.py`'s `locks/<name>.json` shape field for field. */
export interface CoordLockEntry {
  lock: string;
  sessionId: string;
  pid: number | null;
  procStart: number | string | null;
  name: string;
  acquiredAt: number;
  note: string;
}

/** The subset of a harness session record (`~/.claude/sessions/<pid>.json`) coordlib's own
 *  liveness check reads: `pid`, `sessionId`, `procStart`. */
export interface CoordSessionRecord {
  pid: number;
  sessionId: string;
  procStart: number | string;
}

export interface CoordLockDeps {
  /** The coordination root. Locks live under `<coordDir>/locks/<name>.json`. */
  coordDir: string;
  /** The harness session registry directory. */
  sessionsDir: string;
  pid?: number;
  now?: () => number;
}

export type CoordLockResult =
  | { ok: true }
  | { ok: false; reason: string; holder?: CoordLockEntry };

/** Locks Forge is ever allowed to take. An unlisted name is refused outright, the same
 *  as `coordlib.py`'s own `acquire_lock` refuses a name outside `KNOWN_LOCKS`: a lock
 *  nothing honours is worse than no lock at all. */
export const FORGE_HONOURED_LOCKS: ReadonlySet<string> = new Set([
  'gradle-build', 'main-checkout-bb', 'main-checkout-infra',
]);

export class CoordLock {
  private readonly pid: number;
  private readonly sessionId: string;
  private readonly procStart: number;
  private readonly now: () => number;

  constructor(private readonly deps: CoordLockDeps) {
    this.pid = deps.pid ?? process.pid;
    this.now = deps.now ?? Date.now;
    this.sessionId = `forge:${this.pid}:${randomUUID()}`;
    this.procStart = this.now();
  }

  private lockPath(name: string): string {
    return join(this.deps.coordDir, 'locks', `${name}.json`);
  }

  private sessionPath(pid: number): string {
    return join(this.deps.sessionsDir, `${pid}.json`);
  }

  private readEntry(path: string): CoordLockEntry | undefined {
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as CoordLockEntry;
    } catch {
      return undefined;
    }
  }

  private readSession(pid: number): CoordSessionRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.sessionPath(pid), 'utf8')) as CoordSessionRecord;
    } catch {
      return undefined;
    }
  }

  /** coordlib's own liveness rule: the holder's session record, read fresh, has to match
   *  the sessionId and procStart the lock itself recorded. */
  private isLive(entry: CoordLockEntry): boolean {
    if (entry.pid === null) return false;
    const record = this.readSession(entry.pid);
    if (!record) return false;
    return record.sessionId === entry.sessionId && String(record.procStart) === String(entry.procStart);
  }

  /** Writes this process's own harness session record, so a lock this process holds
   *  reads live to coordlib's guard the same as any interactive session's. Idempotent:
   *  safe to call before every acquire. */
  writeOwnSessionRecord(): void {
    mkdirSync(this.deps.sessionsDir, { recursive: true });
    const record: CoordSessionRecord = { pid: this.pid, sessionId: this.sessionId, procStart: this.procStart };
    writeFileSync(this.sessionPath(this.pid), JSON.stringify(record, null, 2), 'utf8');
  }

  /** Removes this process's own session record. Only safe once no Forge lock this
   *  process holds is still needed -- callers that acquire more than one lock at a time
   *  should not call this until every one of them has been released. */
  clearOwnSessionRecord(): void {
    const path = this.sessionPath(this.pid);
    if (existsSync(path)) unlinkSync(path);
  }

  /**
   * Atomic create (`wx`), the same as coordlib's own `_acquire_one_lock`. A live holder
   * refuses; a stale one (its own session record gone, or naming a different session) is
   * stolen: unlinked and the create retried once, exactly coordlib's own two-attempt loop.
   */
  acquire(name: string, note = ''): CoordLockResult {
    if (!FORGE_HONOURED_LOCKS.has(name)) {
      return { ok: false, reason: `${name} is not a lock Forge honours` };
    }
    this.writeOwnSessionRecord();
    const dir = join(this.deps.coordDir, 'locks');
    mkdirSync(dir, { recursive: true });
    const path = this.lockPath(name);
    const mine: CoordLockEntry = {
      lock: name, sessionId: this.sessionId, pid: this.pid, procStart: this.procStart,
      name: 'forge', acquiredAt: this.now(), note,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, 'wx');
        try {
          writeSync(fd, JSON.stringify(mine, null, 2));
        } finally {
          closeSync(fd);
        }
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = this.readEntry(path);
        if (!holder) return { ok: false, reason: `lock file for ${name} could not be read` };
        if (holder.sessionId === this.sessionId) return { ok: true };
        if (this.isLive(holder)) {
          return { ok: false, reason: `${name} is held by ${holder.name || holder.sessionId}`, holder };
        }
        try {
          unlinkSync(path);
        } catch {
          // Lost the race to unlink a stale lock: the winner's create wins instead.
        }
      }
    }
    return { ok: false, reason: `could not acquire ${name} after retrying a stale holder` };
  }

  /** Releases a lock this process holds. Refuses to touch a lock held by anyone else,
   *  live or not -- coordlib's own `release_lock` requires `--force` for that, and this
   *  never carries that option at all. */
  release(name: string): boolean {
    const path = this.lockPath(name);
    if (!existsSync(path)) return true;
    const holder = this.readEntry(path);
    if (holder && holder.sessionId !== this.sessionId) return false;
    try {
      unlinkSync(path);
    } catch {
      return false;
    }
    return true;
  }
}

/**
 * B.7: which shared main checkouts exist, and the coordination lock a hop must hold
 * before touching each one, is workspace configuration, never a path this repository
 * hardcodes -- flightdeck's own agnostic check refuses a project name or an absolute
 * path committed to source, and rightly so: a different machine's workspace names
 * different repositories at different paths. `FORGE_MAIN_CHECKOUTS` carries it instead,
 * the same `path=lock[,path=lock...]` shape `FORGE_REPO_CHECKOUTS` already uses
 * elsewhere, read fresh from `env` on every call rather than cached at import time.
 */
export function parseMainCheckouts(raw: string | undefined): Array<{ path: string; lock: string }> {
  if (!raw || raw.trim().length === 0) return [];
  return raw.split(',').map((entry) => {
    const trimmed = entry.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) throw new Error(`malformed FORGE_MAIN_CHECKOUTS entry "${trimmed}" (expected path=lock)`);
    return { path: trimmed.slice(0, eq).trim(), lock: trimmed.slice(eq + 1).trim() };
  });
}

function normalizeCheckoutPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The lock a `cwd` needs before a hop touches it, or undefined when `cwd` is not one of
 *  the configured shared main checkouts at all (a worktree, or anything else Forge owns
 *  outright). */
export function mainCheckoutLockFor(
  cwd: string, env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const target = normalizeCheckoutPath(cwd);
  const checkouts = parseMainCheckouts(env['FORGE_MAIN_CHECKOUTS']);
  return checkouts.find((entry) => normalizeCheckoutPath(entry.path) === target)?.lock;
}

export type MainCheckoutGuardResult = { ok: true } | { ok: false; reason: string };

/**
 * B.7: a hop whose cwd resolves to a main checkout refuses outright without holding that
 * checkout's own lock -- never a workaround, per the workspace's own coordination rule
 * that a denied command means another session's territory, and the way through is
 * coordination, not a bypass.
 */
export function refuseIfMainCheckoutUnlocked(
  cwd: string, hasLock: (name: string) => boolean, env: NodeJS.ProcessEnv = process.env,
): MainCheckoutGuardResult {
  const lock = mainCheckoutLockFor(cwd, env);
  if (!lock) return { ok: true };
  if (hasLock(lock)) return { ok: true };
  return { ok: false, reason: `${cwd} is a shared main checkout; refusing without the ${lock} lock held` };
}
