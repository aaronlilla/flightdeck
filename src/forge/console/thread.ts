/**
 * `GET /thread` and `GET /run/:id/thread`: the Conductor rail's persisted history.
 *
 * The rail's own messages (operator/reply/plan/confirm/receipt/question/pr/refusal) live
 * in `~/.forge/console/thread.jsonl`, written by the write half (S3) as commands run and
 * cards resolve. This module only reads that file and merges in system event chips
 * generated fresh from the journal, so a chip always describes the row it names rather
 * than a copy of one that can drift from it.
 */
import { existsSync, readFileSync } from 'node:fs';

import type { ForgeEvent } from '../journal.js';
import type { RunMessage } from '../runinbox.js';
import type { Message, ThreadResponse } from '../../shared/console-model.js';
import { textFor } from './journal-route.js';

export function threadPath(forgeHomeDir: string): string {
  return `${forgeHomeDir}/console/thread.jsonl`;
}

/** Read-only: the write half owns appending to this file. A half-written last line is
 *  dropped rather than thrown on, the same tolerance the journal itself gives a torn
 *  tail. */
export function readThread(path: string): Message[] {
  if (!existsSync(path)) return [];
  const messages: Message[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      // Ignored: the writer's own fsync-per-line discipline means this is only ever the
      // very last line, mid-write.
    }
  }
  return messages;
}

/** Event names the rail mirrors as a centered system chip. Named explicitly (per the
 *  brief) rather than "everything with a run" -- a chip is a headline, not a transcript. */
const CHIP_EVENTS = new Set([
  'run.parked', 'ask.answered', 'chain.merged', 'run.killed', 'liveness.stuck',
  'warden.parked', 'external.complete',
]);

function chipFor(row: ForgeEvent): Message {
  return {
    k: `chip-${row.id}`,
    type: 'event',
    text: textFor(row),
    ts: row.at,
    source: row.run ?? 'system',
    lane: row.run,
    verifiedAt: row.at,
  };
}

/**
 * The board-wide thread: every persisted rail message plus one system chip per matching
 * journal row since the earliest persisted message (or since `now` when the thread is
 * still empty, so a fresh console does not replay the fleet's whole history as chips on
 * its very first read).
 */
export function computeThread(persisted: Message[], events: ForgeEvent[], now: number): ThreadResponse {
  const earliest = persisted.length ? Math.min(...persisted.map((message) => message.ts)) : now;
  const chips = events
    .filter((row) => CHIP_EVENTS.has(row.event) && row.at >= earliest)
    .map(chipFor);
  const messages = [...persisted, ...chips].sort((a, b) => a.ts - b.ts);
  return { messages };
}

function runMessageToMessage(message: RunMessage): Message {
  return {
    k: `run-inbox-${message.id}`,
    type: 'operator',
    text: message.text,
    ts: message.at,
    source: message.from,
  };
}

/**
 * `GET /run/:id/thread`: one run's own journal rows rendered as messages (every event
 * naming this run, in order), plus whatever `RunInbox` has queued for it -- read, never
 * consumed, so the console showing this thread never marks a message delivered before
 * the run's own next tool call actually does.
 */
export function computeRunThread(run: string, events: ForgeEvent[], runInboxMessages: RunMessage[]): { messages: Message[] } {
  const own = events
    .filter((row) => row.run === run)
    .map((row) => ({
      k: `run-${run}-${row.id}`,
      type: 'event' as const,
      text: textFor(row),
      ts: row.at,
      source: run,
      lane: run,
      verifiedAt: row.at,
    }));
  const inbox = runInboxMessages.map(runMessageToMessage);
  return { messages: [...own, ...inbox].sort((a, b) => a.ts - b.ts) };
}
