/**
 * B.7: Forge locks written in coordlib's exact schema, honoured across process
 * boundaries by writing the harness session record coordlib's own liveness check reads.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CoordLock, mainCheckoutLockFor, refuseIfMainCheckoutUnlocked,
} from '../../src/forge/coordlock.js';

function tempDirs(): { coordDir: string; sessionsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-coordlock-'));
  const coordDir = join(root, 'coordination');
  const sessionsDir = join(root, 'sessions');
  return { coordDir, sessionsDir };
}

describe('CoordLock', () => {
  it('refuses a lock name Forge does not honour, without touching disk', () => {
    const { coordDir, sessionsDir } = tempDirs();
    const lock = new CoordLock({ coordDir, sessionsDir, pid: 111 });
    const result = lock.acquire('rn-dev-loop');
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('not a lock Forge honours') });
    expect(existsSync(join(coordDir, 'locks', 'rn-dev-loop.json'))).toBe(false);
  });

  it('acquires a fresh lock in coordlib\'s exact schema, and writes its own session record', () => {
    const { coordDir, sessionsDir } = tempDirs();
    const lock = new CoordLock({ coordDir, sessionsDir, pid: 222, now: () => 1_700_000_000_000 });

    const result = lock.acquire('gradle-build', 'android verify');
    expect(result).toEqual({ ok: true });

    const entry = JSON.parse(readFileSync(join(coordDir, 'locks', 'gradle-build.json'), 'utf8'));
    expect(entry).toMatchObject({
      lock: 'gradle-build', pid: 222, acquiredAt: 1_700_000_000_000, note: 'android verify',
    });
    expect(typeof entry.sessionId).toBe('string');
    expect(entry.sessionId.length).toBeGreaterThan(0);
    // coordlib's exact field set, no more and no fewer.
    expect(Object.keys(entry).sort()).toEqual(
      ['acquiredAt', 'lock', 'name', 'note', 'pid', 'procStart', 'sessionId'].sort(),
    );

    const session = JSON.parse(readFileSync(join(sessionsDir, '222.json'), 'utf8'));
    expect(session.pid).toBe(222);
    expect(session.sessionId).toBe(entry.sessionId);
    expect(String(session.procStart)).toBe(String(entry.procStart));
  });

  it('a second acquire by a different process for the same lock is refused while the holder is live', () => {
    const { coordDir, sessionsDir } = tempDirs();
    const holder = new CoordLock({ coordDir, sessionsDir, pid: 333 });
    expect(holder.acquire('gradle-build')).toEqual({ ok: true });

    const other = new CoordLock({ coordDir, sessionsDir, pid: 444 });
    const result = other.acquire('gradle-build');
    expect(result.ok).toBe(false);
  });

  it('steals a lock whose holder session record is gone (a crashed process)', () => {
    const { coordDir, sessionsDir } = tempDirs();
    const holder = new CoordLock({ coordDir, sessionsDir, pid: 555 });
    expect(holder.acquire('gradle-build')).toEqual({ ok: true });
    holder.clearOwnSessionRecord(); // simulates the holder's process dying, taking its session file with it

    const other = new CoordLock({ coordDir, sessionsDir, pid: 666 });
    expect(other.acquire('gradle-build')).toEqual({ ok: true });

    const entry = JSON.parse(readFileSync(join(coordDir, 'locks', 'gradle-build.json'), 'utf8'));
    expect(entry.pid).toBe(666);
  });

  it('steals a lock whose session record has drifted (a different sessionId now at that pid)', () => {
    const { coordDir, sessionsDir } = tempDirs();
    const holder = new CoordLock({ coordDir, sessionsDir, pid: 777 });
    expect(holder.acquire('gradle-build')).toEqual({ ok: true });
    // pid 777 got reused by an unrelated process with its own session file.
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, '777.json'), JSON.stringify({ pid: 777, sessionId: 'someone-else', procStart: 0 }));

    const other = new CoordLock({ coordDir, sessionsDir, pid: 888 });
    expect(other.acquire('gradle-build')).toEqual({ ok: true });
  });

  it('release only lets the actual holder release, and is idempotent on an already-free lock', () => {
    const { coordDir, sessionsDir } = tempDirs();
    const holder = new CoordLock({ coordDir, sessionsDir, pid: 999 });
    holder.acquire('gradle-build');

    const other = new CoordLock({ coordDir, sessionsDir, pid: 1000 });
    expect(other.release('gradle-build')).toBe(false);

    expect(holder.release('gradle-build')).toBe(true);
    expect(existsSync(join(coordDir, 'locks', 'gradle-build.json'))).toBe(false);
    expect(holder.release('gradle-build')).toBe(true); // free already: still true
  });

  it('re-acquiring a lock this same instance already holds succeeds without stealing', () => {
    const { coordDir, sessionsDir } = tempDirs();
    const lock = new CoordLock({ coordDir, sessionsDir, pid: 1111 });
    expect(lock.acquire('gradle-build')).toEqual({ ok: true });
    expect(lock.acquire('gradle-build')).toEqual({ ok: true });
  });
});

describe('B.7: main-checkout guard', () => {
  const env = { FORGE_MAIN_CHECKOUTS: '/checkouts/backend=main-checkout-backend,/checkouts/infra=main-checkout-infra' };

  it('names the lock for a configured main checkout', () => {
    expect(mainCheckoutLockFor('/checkouts/backend', env)).toBe('main-checkout-backend');
    expect(mainCheckoutLockFor('\\checkouts\\infra\\', env)).toBe('main-checkout-infra');
  });

  it('names nothing for a worktree or an unrelated path', () => {
    expect(mainCheckoutLockFor('/worktrees/backend--fix-1', env)).toBeUndefined();
    expect(mainCheckoutLockFor('/checkouts/frontend', env)).toBeUndefined();
  });

  it('names nothing at all when FORGE_MAIN_CHECKOUTS is unset', () => {
    expect(mainCheckoutLockFor('/checkouts/backend', {})).toBeUndefined();
  });

  it('refuses a main-checkout hop without the lock, and allows it with the lock held', () => {
    const refused = refuseIfMainCheckoutUnlocked('/checkouts/infra', () => false, env);
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining('main-checkout-infra') });

    const allowed = refuseIfMainCheckoutUnlocked('/checkouts/infra', (name) => name === 'main-checkout-infra', env);
    expect(allowed).toEqual({ ok: true });
  });

  it('never refuses a hop whose cwd is not a configured main checkout at all', () => {
    expect(refuseIfMainCheckoutUnlocked('/worktrees/anything', () => false, env)).toEqual({ ok: true });
  });
});
