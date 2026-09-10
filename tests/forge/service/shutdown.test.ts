/**
 * The console has no clean stop today: SIGTERM just kills the process mid-tick, mid-lock,
 * mid-request. A service that cannot stop cleanly corrupts the queue lock and drops
 * in-flight council rounds. `installShutdown` wires SIGINT/SIGTERM/SIGBREAK to clear the
 * tick, close the server (waiting for in-flight work), release the queue lock, journal
 * `console.stopped`, and exit 0 -- once, no matter how many signals arrive.
 */
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { installShutdown } from '../../../src/forge/service/shutdown.js';

function fakeJournal() {
  const rows: Record<string, unknown>[] = [];
  let closed = false;
  return {
    rows,
    closed: () => closed,
    append: (event: Record<string, unknown>) => {
      rows.push(event);
      return event;
    },
    close: () => { closed = true; },
  };
}

describe('installShutdown', () => {
  it('clears the tick, releases the queue lock, journals console.stopped, and exits 0 on SIGTERM', async () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const tick = { cleared: false };
    const clearTick = vi.fn(() => { tick.cleared = true; });
    let closeResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { closeResolve = resolve; });
    const server = { close: vi.fn(() => closed) };
    const released = vi.fn();
    const queueLock = { release: released };
    const journal = fakeJournal();
    const onExit = vi.fn();

    installShutdown({
      server, clearTick, queueLock, journal, onExit, process: proc,
    });

    proc.emit('SIGTERM');
    // close() has not resolved yet -- nothing has finished
    expect(clearTick).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    closeResolve?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(released).toHaveBeenCalledTimes(1);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0]?.['event']).toBe('console.stopped');
    expect(journal.rows[0]?.['reason']).toBe('SIGTERM');
    // Privacy: no transcript or prompt text, ever -- nothing but the reason string.
    expect(JSON.stringify(journal.rows[0])).not.toMatch(/transcript|prompt/i);
    expect(journal.closed()).toBe(true);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('waits for an in-flight request to finish before releasing the lock', async () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    let finishRequest: (() => void) | undefined;
    const requestFinished = vi.fn();
    const server = {
      close: vi.fn(() => new Promise<void>((resolve) => {
        finishRequest = () => { requestFinished(); resolve(); };
      })),
    };
    const released = vi.fn();
    const journal = fakeJournal();
    const onExit = vi.fn();

    installShutdown({
      server, clearTick: vi.fn(), queueLock: { release: released }, journal, onExit, process: proc,
    });

    proc.emit('SIGINT');
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();

    finishRequest?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(requestFinished).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('runs the shutdown sequence once no matter how many signals arrive', async () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const server = { close: vi.fn(() => Promise.resolve()) };
    const released = vi.fn();
    const journal = fakeJournal();
    const onExit = vi.fn();

    installShutdown({
      server, clearTick: vi.fn(), queueLock: { release: released }, journal, onExit, process: proc,
    });

    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('has no queue lock to release when none was passed', async () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const server = { close: vi.fn(() => Promise.resolve()) };
    const journal = fakeJournal();
    const onExit = vi.fn();

    installShutdown({ server, clearTick: vi.fn(), journal, onExit, process: proc });

    proc.emit('SIGBREAK');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(journal.rows[0]?.['reason']).toBe('SIGBREAK');
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('forces exit after the close timeout instead of hanging forever', async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const server = { close: vi.fn(() => new Promise<void>(() => { /* never resolves */ })) };
    const released = vi.fn();
    const journal = fakeJournal();
    const onExit = vi.fn();

    installShutdown({
      server, clearTick: vi.fn(), queueLock: { release: released }, journal, onExit, process: proc,
      closeTimeoutMs: 10_000,
    });

    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(released).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });
});
