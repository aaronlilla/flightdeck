#!/usr/bin/env -S npx tsx
/**
 * R-101: proof that a new Jira ticket reaches the queue on time while the console's main
 * thread is held. Serves a fake Jira on localhost, points a temp FORGE_HOME at it, starts
 * the watcher, lets a ticket appear, then holds this thread in a busy loop for 4 s and
 * reads when the ticket's queue row was written.
 *
 *   mode `thread` (the production wiring): the row lands during the hold.
 *   mode `inline` (the old wiring): nothing can land until the hold ends.
 *
 * Prints one JSON line and exits 0 when the row was written within 2.5 s of the ticket
 * appearing, 1 otherwise. `tests/forge/sync/watcher-thread-real.test.ts` runs both modes.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const mode = process.argv[2] === 'inline' ? 'inline' : 'thread';
const HOLD_MS = 4000;
const BUDGET_MS = 2500;

// The fake Jira runs on its own thread. On this one it could not answer while the hold
// below runs, and every mode would miss the budget for a reason that has nothing to do
// with the watcher: the sensor would be built from the thing under test.
const home = mkdtempSync(join(tmpdir(), 'watcher-thread-check-'));
const flag = join(home, 'ticket-visible');
const fakeJira = new Worker(`
  const { createServer } = require('node:http');
  const { existsSync } = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const search = (request.url || '').includes('/search/jql');
      const issues = search && existsSync(workerData.flag)
        ? [{ key: 'ABC-1', fields: { summary: 'New ticket', status: { name: 'Backlog', statusCategory: { key: 'new' } }, updated: '2026-09-14T08:00:00.000+0000', labels: [] } }]
        : [];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(search ? { issues, isLast: true } : {}));
    });
  });
  server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
`, { eval: true, workerData: { flag } });
const port = await new Promise<number>((resolve) => { fakeJira.once('message', resolve); });

process.env['FORGE_HOME'] = home;
process.env['FORGE_JIRA_SITE'] = `http://127.0.0.1:${port}`;
process.env['FORGE_JIRA_EMAIL'] = 'check@example.test';
process.env['FORGE_JIRA_TOKEN'] = 'not-a-token';

const { QueueStore } = await import('../src/forge/intake/queueStore.js');
const { fileWatermarkStore } = await import('../src/forge/intake/watermarkStore.js');
const { Journal } = await import('../src/forge/journal.js');
const { journalPath, queuePath } = await import('../src/forge/paths.js');
const { jiraConfigFromEnv } = await import('../src/forge/queue-wire.js');
const { JiraWatcher } = await import('../src/forge/sync/watcher-state.js');
const { ThreadTicketPoller } = await import('../src/forge/sync/watcher-thread-host.js');

const journal = new Journal(journalPath());
let polls = 0;
let firstPoll: () => void = () => undefined;
const firstPolled = new Promise<void>((resolve) => { firstPoll = resolve; });
const watcher = new JiraWatcher({
  jiraConfig: jiraConfigFromEnv, watermarks: fileWatermarkStore(), store: new QueueStore(queuePath()), journal,
  pollSeconds: 1,
  ...(mode === 'thread' ? { poller: new ThreadTicketPoller({ pollSeconds: 1, holdLabels: [], journal }) } : {}),
});
watcher.onTicketsAdded(() => undefined);
const originalStatus = watcher.status.bind(watcher);
const waitForPoll = setInterval(() => { if (originalStatus().lastPollAt !== undefined) { polls += 1; firstPoll(); } }, 50);
void watcher.start('ABC');
await firstPolled;
clearInterval(waitForPoll);

writeFileSync(flag, '1');
const appearedAt = Date.now();
const until = appearedAt + HOLD_MS;
while (Date.now() < until) { /* hold this thread, the way a long synchronous read does */ }

const row = new QueueStore(queuePath()).all().find((item) => item.ticket === 'ABC-1');
const writtenAfterMs = row ? row.createdAt - appearedAt : null;
watcher.stop();
await fakeJira.terminate();
const ok = writtenAfterMs !== null && writtenAfterMs <= BUDGET_MS;
console.log(JSON.stringify({ mode, holdMs: HOLD_MS, writtenAfterMs, ok, polls }));
process.exit(ok ? 0 : 1);
