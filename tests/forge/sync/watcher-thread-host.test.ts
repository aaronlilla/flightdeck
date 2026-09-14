/**
 * R-101: the main thread's side of the watcher thread. A fake worker stands in for
 * `node:worker_threads`, so these specimens prove the message handling, the stop and the
 * restart without starting a thread (the real thread is proven in
 * `watcher-thread-real.test.ts`).
 */
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { WatcherThreadData, WatcherThreadMessage } from '../../../src/forge/sync/watcher-thread.js';
import { ThreadTicketPoller, type TicketPollResult, type WorkerLike } from '../../../src/forge/sync/watcher-thread-host.js';

class FakeWorker extends EventEmitter implements WorkerLike {
  terminated = false;

  constructor(readonly data: WatcherThreadData) { super(); }

  async terminate(): Promise<number> { this.terminated = true; return 0; }

  post(message: WatcherThreadMessage): void { this.emit('message', message); }
}

function harness() {
  const workers: FakeWorker[] = [];
  const rows: Record<string, unknown>[] = [];
  const timers: (() => void)[] = [];
  const poller = new ThreadTicketPoller({
    pollSeconds: 5, holdLabels: ['fd-e2e'],
    journal: { append: (row) => { rows.push(row as Record<string, unknown>); return row as never; } },
    createWorker: (data) => { const worker = new FakeWorker(data); workers.push(worker); return worker; },
    setTimeoutFn: ((fn: () => void) => { timers.push(fn); return 1 as never; }) as never,
    clearTimeoutFn: (() => undefined) as never,
  });
  return { poller, workers, rows, timers };
}

describe('ThreadTicketPoller', () => {
  it('starts one thread with the project, interval and hold labels, and forwards each poll', () => {
    const h = harness();
    const polled: TicketPollResult[] = [];
    h.poller.start('ABC', (result) => { polled.push(result); });

    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]!.data).toEqual({ project: 'ABC', pollSeconds: 5, holdLabels: ['fd-e2e'] });
    expect(h.poller.running).toBe(true);

    h.workers[0]!.post({ type: 'polled', at: 42, count: 1, addedTickets: ['ABC-7'] });
    expect(polled).toEqual([{ at: 42, count: 1, addedTickets: ['ABC-7'] }]);
  });

  it('appends the journal rows the thread posts on this thread, never forwarding them as polls', () => {
    const h = harness();
    const onPolled = vi.fn();
    h.poller.start('ABC', onPolled);
    h.workers[0]!.post({ type: 'journal', row: { event: 'watcher.poll', message: 'added 1' } });
    expect(h.rows).toEqual([{ event: 'watcher.poll', message: 'added 1' }]);
    expect(onPolled).not.toHaveBeenCalled();
  });

  it('stop terminates the thread, and a late message from it is ignored', () => {
    const h = harness();
    const onPolled = vi.fn();
    h.poller.start('ABC', onPolled);
    const worker = h.workers[0]!;
    h.poller.stop();
    expect(worker.terminated).toBe(true);
    expect(h.poller.running).toBe(false);
    worker.post({ type: 'polled', at: 1, count: 0, addedTickets: [] });
    worker.emit('exit', 1);
    expect(onPolled).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });

  it('a thread that dies on its own is journaled and restarted after one interval', () => {
    const h = harness();
    h.poller.start('ABC', vi.fn());
    h.workers[0]!.emit('exit', 1);
    expect(h.rows.some((row) => row['event'] === 'watcher.tick-error')).toBe(true);
    expect(h.workers).toHaveLength(1);
    h.timers[0]!();
    expect(h.workers).toHaveLength(2);
  });

  it('a thread error reaches the status line as the poll error', () => {
    const h = harness();
    const polled: TicketPollResult[] = [];
    h.poller.start('ABC', (result) => { polled.push(result); });
    h.workers[0]!.emit('error', new Error('cannot find module'));
    expect(polled[0]?.error).toBe('watcher thread failed: cannot find module');
  });
});
