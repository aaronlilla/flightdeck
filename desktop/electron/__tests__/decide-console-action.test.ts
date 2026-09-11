import { describe, it, expect } from 'vitest';
import { decideConsoleAction } from '../server-mode';
import { readQueueLockOwner, type QueueLockFs } from '../queue-lock';

const join = (...parts: string[]) => parts.join('/');

describe('decideConsoleAction', () => {
  // Live finding, 2026-09-11: this app's own env and the already-running console's env
  // can disagree on FORGE_QUEUE (the launcher script sourced its own console.env.cmd,
  // the app read only its own process env plus Settings) -- a healthy console can hold
  // the intake queue lock for its entire lifetime, not just while starting. Wait was
  // meant to protect against launching a second console into a port someone else is
  // mid-launching; a console that already answers up-healthy is not mid-launching, and
  // attaching to it can never create a second console (attach starts nothing). Only the
  // genuinely ambiguous states -- someone else may still be mid-launch -- defer to the
  // lock.
  it('an alive lock owner yields wait for every health EXCEPT up-healthy, which always attaches', () => {
    expect(decideConsoleAction('down', true)).toBe('wait');
    expect(decideConsoleAction('up-healthy', true)).toBe('attach');
    expect(decideConsoleAction('up-no-console', true)).toBe('wait');
    expect(decideConsoleAction('up-foreign', true)).toBe('wait');
  });

  it('up-healthy attaches (no lock owner)', () => {
    expect(decideConsoleAction('up-healthy', false)).toBe('attach');
  });

  it('up-no-console shows the no-console status rather than silently attaching', () => {
    expect(decideConsoleAction('up-no-console', false)).toBe('show-no-console');
  });

  it('up-foreign proposes the confirm-gated restart', () => {
    expect(decideConsoleAction('up-foreign', false)).toBe('confirm-restart');
  });

  it('down with no lock owner starts a fresh console', () => {
    expect(decideConsoleAction('down', false)).toBe('start');
  });
});

describe('readQueueLockOwner', () => {
  it('an alive lock owner is read as alive: true', () => {
    const fs: QueueLockFs = {
      existsSync: (p) => p === '/h/.forge/console/queue.lock',
      readFileSync: () => JSON.stringify({ pid: 4242, at: 1 }),
    };
    const owner = readQueueLockOwner(fs, join, '/h/.forge', (pid) => pid === 4242);
    expect(owner).toEqual({ pid: 4242, alive: true });
  });

  it('a dead lock owner is read as alive: false, not skipped', () => {
    const fs: QueueLockFs = {
      existsSync: (p) => p === '/h/.forge/console/queue.lock',
      readFileSync: () => JSON.stringify({ pid: 4242, at: 1 }),
    };
    const owner = readQueueLockOwner(fs, join, '/h/.forge', () => false);
    expect(owner).toEqual({ pid: 4242, alive: false });
  });

  it('no lock file is undefined', () => {
    const fs: QueueLockFs = { existsSync: () => false, readFileSync: () => '' };
    expect(readQueueLockOwner(fs, join, '/h/.forge', () => true)).toBeUndefined();
  });
});
