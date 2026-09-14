/**
 * R-101: the Jira watcher's poll, run on its own thread. The console's main thread holds
 * itself for seconds at a time (a 30 s profile on 2026-09-14 measured stretches of 6.0,
 * 3.5 and 3.5 s), and a 5 s timer on that thread cannot fire inside one, so a ticket
 * created during a stall took 12.5 s to reach the queue. Here the timer, the Jira search
 * and the queue append all happen off that thread; the row lands in the queue's log no
 * matter what the console is doing, and the console's store reads it on its next pass.
 *
 * The thread never writes the journal itself: `Journal` numbers rows from a per-instance
 * counter, so two threads appending would reuse a sequence number. Journal rows are
 * posted to the main thread, which appends them in order.
 */
import { parentPort, workerData } from 'node:worker_threads';

import type { JiraConfig } from '../intake/jira.js';
import { QueueStore } from '../intake/queueStore.js';
import { fileWatermarkStore } from '../intake/watermarkStore.js';
import { watcherFeed, watcherTick } from '../intake/watcherWire.js';
import { queuePath } from '../paths.js';

export interface WatcherThreadData {
  project: string;
  pollSeconds: number;
  holdLabels: string[];
}

export type WatcherThreadMessage =
  | { type: 'journal'; row: Record<string, unknown> }
  | { type: 'polled'; at: number; count: number; addedTickets: string[]; error?: string };

function configFromEnv(env: NodeJS.ProcessEnv): JiraConfig | undefined {
  const site = env['FORGE_JIRA_SITE'];
  const email = env['FORGE_JIRA_EMAIL'];
  const token = env['FORGE_JIRA_TOKEN'];
  return site && email && token ? { site, email, token } : undefined;
}

if (parentPort) {
  const port = parentPort;
  const data = workerData as WatcherThreadData;
  const post = (message: WatcherThreadMessage): void => { port.postMessage(message); };
  // `Journal.append` returns the stamped row; the main thread stamps it, so this returns
  // nothing a caller could read (no caller of the watcher tick reads it).
  const journal = {
    append: (row: Record<string, unknown>) => { post({ type: 'journal', row }); return row as never; },
  };
  const store = new QueueStore(queuePath());
  const watermarks = fileWatermarkStore();
  let polling = false;

  const tick = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const config = configFromEnv(process.env);
      if (!config) {
        post({ type: 'polled', at: Date.now(), count: 0, addedTickets: [], error: 'no Jira credentials' });
        return;
      }
      const result = await watcherTick({
        feedFor: (ownedKeys) => watcherFeed(data.project, config, ownedKeys),
        watermarks, store, journal, holdLabels: data.holdLabels,
      });
      post({
        type: 'polled', at: Date.now(),
        count: result.addedTickets.length + result.sends.length + result.closed.length,
        addedTickets: result.addedTickets,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      journal.append({ event: 'watcher.tick-error', actor: 'watcher', message });
      post({ type: 'polled', at: Date.now(), count: 0, addedTickets: [], error: message });
    } finally {
      polling = false;
    }
  };

  void tick();
  setInterval(() => { void tick(); }, data.pollSeconds * 1000);
}
