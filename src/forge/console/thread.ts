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
import type { InboxEntry } from '../inbox.js';
import type { RunMessage } from '../runinbox.js';
import type { Message, ThreadResponse } from '../../shared/console-model.js';
import { jidFor, textFor } from './journal-route.js';
import { collapseWardenChips } from './journal-narrative.js';

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

/** `liveness.stuck`/`warden.parked` chips go through `collapseWardenChips` instead of
 *  the ordinary one-row-one-chip mapping below (H1.9) -- a stuck-session trip re-fires
 *  the same row on every liveness tick, and the rail used to render every one of them. */
const WARDEN_CHIP_EVENTS = new Set(['liveness.stuck', 'warden.parked']);

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

function wardenChipMessages(events: ForgeEvent[]): Message[] {
  return collapseWardenChips(events).map((chip) => ({
    k: `chip-warden-${chip.lane}-${chip.at}`,
    type: 'event',
    text: chip.text,
    ts: chip.at,
    source: chip.lane,
    lane: chip.lane,
    verifiedAt: chip.at,
  }));
}

/** An open inbox ask, rendered as the rail's own answerable `question` card (the same
 *  shape `MessageCard` already knows how to draw with clickable option buttons) --
 *  otherwise a live parked run's question reached the needs-you plate (which reads
 *  `lane.question` straight off `/lanes`) and nowhere else, leaving an operator with no
 *  click-to-answer path at all, only the composer's `answer <key> <text>` typed by hand. */
function questionMessageFor(entry: InboxEntry): Message {
  return {
    k: `question-${entry.key}`,
    type: 'question',
    text: entry.question,
    ts: entry.at,
    source: entry.runs[0] ?? 'system',
    askKey: entry.key,
    opts: entry.options,
    verifiedAt: entry.at,
  };
}

/**
 * The board-wide thread: every persisted rail message, one system chip per matching
 * journal row since the earliest persisted message (or since `now` when the thread is
 * still empty, so a fresh console does not replay the fleet's whole history as chips on
 * its very first read), plus one answerable question card per still-open inbox ask that
 * has not already been persisted under the same key.
 */
export function computeThread(
  persisted: Message[], events: ForgeEvent[], now: number, openAsks: InboxEntry[] = [],
): ThreadResponse {
  const earliest = persisted.length ? Math.min(...persisted.map((message) => message.ts)) : now;
  const windowed = events.filter((row) => row.at >= earliest);
  const ordinaryChips = windowed
    .filter((row) => CHIP_EVENTS.has(row.event) && !WARDEN_CHIP_EVENTS.has(row.event))
    .map(chipFor);
  const chips = [...ordinaryChips, ...wardenChipMessages(windowed.filter((row) => WARDEN_CHIP_EVENTS.has(row.event)))];
  const persistedKeys = new Set(persisted.map((message) => message.k));
  const questions = openAsks
    .map(questionMessageFor)
    .filter((message) => !persistedKeys.has(message.k));
  const messages = [...persisted, ...chips, ...questions].sort((a, b) => a.ts - b.ts);
  return { messages };
}

/** `forge_report`'s own text fields (`ForgeReportInputSchema` in `contracts.ts`), joined
 *  into the one summary a `forge.report` row becomes on the run's own thread. */
function forgeReportText(row: ForgeEvent): string {
  const lines: string[] = [];
  if (typeof row.outcome === 'string') lines.push(row.outcome);
  if (typeof row.done === 'string') lines.push(`Done: ${row.done}`);
  if (typeof row.leftOff === 'string') lines.push(`Left off: ${row.leftOff}`);
  if (typeof row.issues === 'string') lines.push(`Issues: ${row.issues}`);
  if (typeof row.blockers === 'string') lines.push(`Blockers: ${row.blockers}`);
  if (typeof row.unverified === 'string') lines.push(`Unverified: ${row.unverified}`);
  return lines.join('\n') || 'filed a report';
}

/** One of the run's own journal rows, rendered as the message kind its content earns:
 *  `forge.report` and `forge.done` are the run's own account of itself, so they read as
 *  a `reply` from the run rather than a one-line event chip; a console write's own
 *  `decision.made` row reads as the `receipt` it always was, jid and all, since that
 *  jid is what `POST /journal/:jid/undo` needs back. Everything else keeps the plain
 *  event rendering the board already uses everywhere.
 */
function runRowToMessage(run: string, row: ForgeEvent): Message {
  const k = `run-${run}-${row.id}`;
  if (row.event === 'forge.report') {
    return { k, type: 'reply', text: forgeReportText(row), ts: row.at, source: run };
  }
  if (row.event === 'forge.done') {
    return { k, type: 'reply', text: typeof row.evidence === 'string' ? row.evidence : 'done', ts: row.at, source: run };
  }
  if (row.event === 'decision.made') {
    return { k, type: 'receipt', text: textFor(row), ts: row.at, source: run, jid: jidFor(row) };
  }
  return { k, type: 'event', text: textFor(row), ts: row.at, source: run, lane: run, verifiedAt: row.at };
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
    .map((row) => runRowToMessage(run, row));
  const inbox = runInboxMessages.map(runMessageToMessage);
  return { messages: [...own, ...inbox].sort((a, b) => a.ts - b.ts) };
}
