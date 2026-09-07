import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireQueueLock } from '../../../src/forge/intake/queueLock.js';

describe('acquireQueueLock: one process ticks a queue at a time', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function lockPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-qlock-'));
    dirs.push(dir);
    return join(dir, 'queue.lock');
  }

  it('takes a free lock, writes its own pid, and releases it', () => {
    const path = lockPath();
    const lock = acquireQueueLock({ path, pid: 4242, alive: () => true, clock: () => 1000 });
    expect(lock.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 4242, at: 1000 });
    if (lock.ok) lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses while a live process holds it, naming that pid', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 7, at: 500 }));
    const lock = acquireQueueLock({ path, pid: 4242, alive: (pid) => pid === 7, clock: () => 1000 });
    expect(lock).toEqual({ ok: false, holder: 7, reason: 'another console (pid 7) owns this queue' });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(7);
  });

  it('takes over a lock whose holder is dead', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 7, at: 500 }));
    const lock = acquireQueueLock({ path, pid: 4242, alive: () => false, clock: () => 1000 });
    expect(lock.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(4242);
  });

  it('treats an unreadable lock file as held by nobody', () => {
    const path = lockPath();
    writeFileSync(path, 'not json');
    const lock = acquireQueueLock({ path, pid: 4242, alive: () => true, clock: () => 1000 });
    expect(lock.ok).toBe(true);
  });

  it('does not release a lock another process has since taken', () => {
    const path = lockPath();
    const lock = acquireQueueLock({ path, pid: 4242, alive: () => true, clock: () => 1000 });
    writeFileSync(path, JSON.stringify({ pid: 9, at: 2000 }));
    if (lock.ok) lock.release();
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(9);
  });
});
