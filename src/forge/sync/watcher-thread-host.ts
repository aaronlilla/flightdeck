/**
 * R-101: the main thread's side of `watcher-thread.ts`. Starts the thread, appends the
 * journal rows it posts, hands each poll result to `JiraWatcher`, and restarts a thread
 * that dies on its own after one poll interval, so a crash reads as an error on the
 * status line rather than a watcher that silently stopped.
 */
import { Worker } from 'node:worker_threads';

import type { Journal } from '../journal.js';
import type { WatcherThreadData, WatcherThreadMessage } from './watcher-thread.js';

export interface TicketPollResult {
  at: number;
  count: number;
  addedTickets: string[];
  error?: string;
}

/** Where the watcher's poll runs. `JiraWatcher` polls in-process when none is given. */
export interface TicketPoller {
  start(project: string, onPolled: (result: TicketPollResult) => void): void;
  stop(): void;
  readonly running: boolean;
}

/** The slice of `Worker` this file uses, so a test can hand in a fake. */
export interface WorkerLike {
  // The parameter is `name`, not `event`: `tests/forge/contracts.test.ts` reads every
  // quoted string after an `event` key under src/forge as a journal event name.
  on(name: 'message', listener: (message: WatcherThreadMessage) => void): unknown;
  on(name: 'error', listener: (error: Error) => void): unknown;
  on(name: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export function createWatcherWorker(data: WatcherThreadData): WorkerLike {
  // Run from source under tsx the sibling is `.ts`; from `dist` it is `.js`.
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new Worker(new URL(`./watcher-thread${extension}`, import.meta.url), { workerData: data }) as unknown as WorkerLike;
}

export interface ThreadTicketPollerOptions {
  pollSeconds: number;
  holdLabels: readonly string[];
  journal: Pick<Journal, 'append'>;
  createWorker?: (data: WatcherThreadData) => WorkerLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class ThreadTicketPoller implements TicketPoller {
  private worker: WorkerLike | undefined;

  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  private wanted: { project: string; onPolled: (result: TicketPollResult) => void } | undefined;

  constructor(private readonly opts: ThreadTicketPollerOptions) {}

  get running(): boolean {
    return this.wanted !== undefined;
  }

  start(project: string, onPolled: (result: TicketPollResult) => void): void {
    this.stop();
    this.wanted = { project, onPolled };
    this.spawn();
  }

  stop(): void {
    this.wanted = undefined;
    if (this.restartTimer) {
      (this.opts.clearTimeoutFn ?? clearTimeout)(this.restartTimer);
      this.restartTimer = undefined;
    }
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private spawn(): void {
    const wanted = this.wanted;
    if (!wanted) return;
    const create = this.opts.createWorker ?? createWatcherWorker;
    const worker = create({ project: wanted.project, pollSeconds: this.opts.pollSeconds, holdLabels: [...this.opts.holdLabels] });
    this.worker = worker;
    worker.on('message', (message) => {
      if (this.worker !== worker) return;
      if (message.type === 'journal') {
        try { this.opts.journal.append(message.row as never); } catch { /* a failed append never stops the poll */ }
        return;
      }
      wanted.onPolled({
        at: message.at, count: message.count, addedTickets: message.addedTickets,
        ...(message.error !== undefined ? { error: message.error } : {}),
      });
    });
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      wanted.onPolled({ at: Date.now(), count: 0, addedTickets: [], error: `watcher thread failed: ${error.message}` });
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker || !this.wanted) return;
      this.worker = undefined;
      try {
        this.opts.journal.append({ event: 'watcher.tick-error', actor: 'watcher', message: `watcher thread exited (${code}); restarting` } as never);
      } catch { /* as above */ }
      this.restartTimer = (this.opts.setTimeoutFn ?? setTimeout)(() => {
        this.restartTimer = undefined;
        this.spawn();
      }, this.opts.pollSeconds * 1000);
    });
  }
}
