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
import { collapseWardenChips, railChipText, type TitleForFn } from './journal-narrative.js';
import { clock, commandEcho, humanizeParkReason, receiptText, stripMachineIds } from '../../shared/humanize.js';
import { modelAlias } from './lanes.js';
import { modelName } from './plain.js';

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

function chipFor(row: ForgeEvent, titleFor: TitleForFn): Message {
  return {
    k: `chip-${row.id}`,
    type: 'event',
    // Every `CHIP_EVENTS` member has its own phrasing in `railChipText`; this fallback
    // is defensive only, and still never lets a raw run id or ask key reach the rail.
    text: railChipText(row, titleFor) ?? stripMachineIds(textFor(row), { labelFor: titleFor }),
    ts: row.at,
    source: row.run ?? 'system',
    lane: row.run,
    verifiedAt: row.at,
  };
}

function wardenChipMessages(events: ForgeEvent[], titleFor: TitleForFn): Message[] {
  return collapseWardenChips(events, titleFor).map((chip) => ({
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
    recommended: entry.recommended ?? null,
    optionSource: entry.optionSource,
    verifiedAt: entry.at,
  };
}

export interface ComputeThreadOptions {
  /** `true` leaves every persisted row exactly as stored -- what `GET /thread?verbose=1`
   *  always has. Default (unset/false): plain mode -- a persisted `operator` command
   *  reads through `commandEcho`, a `receipt` through `receiptText`, and a `reply`/
   *  `refusal` has every machine id stripped out of it. */
  verbose?: boolean;
  /** Every inbox entry, open and answered -- what a `receipt`'s own `questionFor` needs
   *  to name the question an "answered <key>" row was about. Defaults to `openAsks`
   *  when unset, so a caller that has not wired the full inbox still answers open
   *  questions correctly, just not already-answered ones. */
  allAsks?: InboxEntry[];
}

/** Deliverable 8: a persisted rail row humanized at read time, so an operator bubble or
 *  a receipt written before this deliverable shipped reads in words on its very next
 *  fetch -- nothing needs rewriting on disk. An `operator` command reads through
 *  `commandEcho`, a `receipt` through `receiptText`; every other type's own `text`
 *  reads through plain `stripMachineIds`.
 *
 *  Item 7: that same strip runs over every OTHER text-bearing field a card can carry
 *  too -- a confirm card's `blast` line, a plan or question card's `items[].text`, and
 *  a question card's own `opts[]` -- not just `text`. `askKey`, `jid`, `k`, `source`
 *  and `lane` are keys the client needs to match a card to its action, never text a
 *  person reads, and stay exactly as they are. */
function humanizeMessage(message: Message, labelFor: TitleForFn, questionFor: (key: string) => string | null): Message {
  const stripText = (text: string): string => stripMachineIds(text, { labelFor });
  const text = message.type === 'operator' ? commandEcho(message.text, { labelFor })
    : message.type === 'receipt' ? receiptText(message.text, { labelFor, questionFor })
      : stripText(message.text);
  return {
    ...message,
    text,
    ...(typeof message.blast === 'string' ? { blast: stripText(message.blast) } : {}),
    ...(message.items ? { items: message.items.map((item) => ({ ...item, text: stripText(item.text) })) } : {}),
    ...(message.opts ? { opts: message.opts.map(stripText) } : {}),
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
  titleFor: TitleForFn = () => null, options: ComputeThreadOptions = {},
): ThreadResponse {
  const earliest = persisted.length ? Math.min(...persisted.map((message) => message.ts)) : now;
  const windowed = events.filter((row) => row.at >= earliest);
  const ordinaryChips = windowed
    .filter((row) => CHIP_EVENTS.has(row.event) && !WARDEN_CHIP_EVENTS.has(row.event))
    .map((row) => chipFor(row, titleFor));
  const chips = [...ordinaryChips, ...wardenChipMessages(windowed.filter((row) => WARDEN_CHIP_EVENTS.has(row.event)), titleFor)];
  const persistedKeys = new Set(persisted.map((message) => message.k));
  let questions = openAsks
    .map(questionMessageFor)
    .filter((message) => !persistedKeys.has(message.k));
  let persistedRows = persisted;
  if (!options.verbose) {
    const allAsks = options.allAsks ?? openAsks;
    const questionFor = (key: string): string | null => allAsks.find((ask) => ask.key === key)?.question ?? null;
    persistedRows = persisted.map((message) => humanizeMessage(message, titleFor, questionFor));
    // Item 7: a freshly-generated question card (one no one has answered yet, so
    // nothing about it is persisted) carries whatever the run's own ask text says --
    // it needs the same strip, or a live parked run's question reaches the rail with
    // its own run id or ask key sitting in plain view.
    questions = questions.map((message) => humanizeMessage(message, titleFor, questionFor));
  }
  const messages = [...persistedRows, ...chips, ...questions].sort((a, b) => a.ts - b.ts);
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
/** A Conductor exchange recorded against this run (2026-09-08): the operator's own
 *  words from a sheet composer, the agent's reply, or a tool receipt, rendered as the
 *  same card the rail shows so the sheet carries the whole exchange. */
function conductorRowToMessage(k: string, row: ForgeEvent): Message {
  const kind = typeof row.kind === 'string' ? row.kind : 'reply';
  const type: Message['type'] = kind === 'receipt' || kind === 'refusal' || kind === 'operator' || kind === 'confirm' || kind === 'plan' ? kind : 'reply';
  const path = row.path === 'agent' || row.path === 'grammar' ? row.path : undefined;
  return {
    k, type, text: String(row.text ?? ''), ts: row.at,
    source: kind === 'operator' ? 'operator' : 'conductor',
    ...(type === 'receipt' ? { resolved: 'ran' as const } : {}),
    ...(path ? { path } : {}),
  };
}

function runRowToMessage(run: string, row: ForgeEvent): Message {
  const k = `run-${run}-${row.id}`;
  if (row.event === 'conductor.receipt') return conductorRowToMessage(k, row);
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

const clockTime = clock;

/** One journal row's own text, in plain words and free of every machine id -- the
 *  general-purpose per-row renderer the why-stuck reply's "Last it did" lines
 *  (deliverable 5) and the cost sheet's own step text (deliverable 11) both reuse,
 *  rather than each inventing its own copy of what an event kind means in words. */
export function plainEventText(row: ForgeEvent): string {
  switch (row.event) {
    case 'tool.start':
      return `Ran ${typeof row.tool === 'string' ? row.tool : 'a tool'}`;
    case 'tool.end':
      return 'Finished a tool call';
    case 'turn.end':
      return 'Finished a turn';
    case 'reasoner.call':
      return 'Reasoner call';
    case 'burn.mismatch':
      return 'Token accounting mismatch';
    case 'registry.abandoned':
      return 'Process record abandoned';
    case 'run.started':
      return 'Started';
    case 'run.parked':
      return `Parked: ${humanizeParkReason(typeof row.reason === 'string' ? row.reason : 'waiting on you')}`;
    case 'warden.parked':
      return `Parked by the warden: ${stripMachineIds(typeof row.reason === 'string' ? row.reason : 'a health check tripped')}`;
    case 'run.resumed':
      return 'Resumed';
    case 'run.killed':
      return `Killed: ${stripMachineIds(typeof row.reason === 'string' ? row.reason : 'no reason recorded')}`;
    case 'run.finished':
      return `Finished: ${typeof row.verdict === 'string' ? row.verdict : 'unverified'}`;
    case 'run.blocked':
      return `Blocked${typeof row.reason === 'string' ? `: ${stripMachineIds(row.reason)}` : ''}`;
    case 'ask.answered':
      return 'Question answered';
    case 'forge.ask':
      return `Asked you: ${stripMachineIds(String(row.question ?? ''))}`;
    default:
      return stripMachineIds(textFor(row));
  }
}

/** A burst of tool-shaped rows folds into one `activity` message in plain mode -- these
 *  are the event kinds that carry no narrative of their own and only ever appear as
 *  part of one. A burst ends the moment a row outside this set is seen. */
const BURST_EVENTS = new Set([
  'tool.start', 'tool.end', 'turn.end', 'result.usage', 'burn.mismatch', 'reasoner.call', 'registry.abandoned',
]);

/** Tool name -> [singular, plural] category label for the activity digest's own count
 *  ("140 commands, 45 file reads"). Anything not named here reads as "N other tool
 *  call(s)" -- never the raw tool name. */
const TOOL_CATEGORY: Record<string, [string, string]> = {
  Bash: ['command', 'commands'],
  Read: ['file read', 'file reads'],
  Edit: ['edit', 'edits'],
  Write: ['edit', 'edits'],
  Grep: ['search', 'searches'],
  Glob: ['search', 'searches'],
  Skill: ['skill', 'skills'],
};

function categoryFor(tool: string): [string, string] {
  return TOOL_CATEGORY[tool] ?? ['other tool call', 'other tool calls'];
}

/** One `activity` message for a burst of tool-shaped rows, counted by `tool.start`'s own
 *  tool name -- `null` for a burst that never carried a single `tool.start` (pure
 *  `burn.mismatch`/`turn.end` noise), which has nothing to tell a person about. A burst
 *  that counted exactly one tool call reads as a single sentence at one clock time,
 *  never a "H:MM to H:MM" range with nothing else in it. */
function activityMessageFor(run: string, burst: ForgeEvent[]): Message | null {
  const counts = new Map<string, { plural: string; count: number }>();
  for (const row of burst) {
    if (row.event !== 'tool.start') continue;
    const tool = typeof row.tool === 'string' ? row.tool : 'unknown';
    const [singular, plural] = categoryFor(tool);
    const existing = counts.get(singular);
    if (existing) existing.count += 1;
    else counts.set(singular, { plural, count: 1 });
  }
  const total = [...counts.values()].reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return null;

  const first = burst[0]!;
  const last = burst[burst.length - 1]!;
  const k = `run-${run}-activity-${first.id}`;

  if (total === 1) {
    const [singular] = [...counts.entries()][0]!;
    return {
      k, type: 'activity', text: `Ran 1 ${singular} at ${clockTime(first.at)}`,
      ts: first.at, source: run, lane: run,
    };
  }

  const parts = [...counts.entries()].map(([singular, entry]) => (
    `${entry.count} ${entry.count === 1 ? singular : entry.plural}`
  ));
  return {
    k, type: 'activity', text: `Worked ${clockTime(first.at)} to ${clockTime(last.at)}: ${parts.join(', ')}`,
    ts: first.at, source: run, lane: run,
  };
}

/** The plain-mode text and message kind for one of the run's own journal rows -- `null`
 *  for a row that carries nothing worth telling a person (a `permission.denied` with no
 *  reason on it). Every text here is already free of machine ids: `run.parked` goes
 *  through `humanizeParkReason` (which itself calls `stripMachineIds`), and everything
 *  else is wrapped directly. */
function plainMessageFor(run: string, row: ForgeEvent): Message | null {
  const k = `run-${run}-${row.id}`;
  const event: Message = { k, type: 'event', text: '', ts: row.at, source: run, lane: run, verifiedAt: row.at };

  switch (row.event) {
    case 'run.started': {
      const model = typeof row.model === 'string' && row.model ? modelName(modelAlias(row.model)) : null;
      return { ...event, text: model ? `Started on ${model} at ${clockTime(row.at)}` : `Started at ${clockTime(row.at)}` };
    }
    case 'forge.report':
      return { k, type: 'reply', text: stripMachineIds(forgeReportText(row)), ts: row.at, source: run };
    case 'forge.done':
      return {
        k, type: 'reply', text: stripMachineIds(typeof row.evidence === 'string' ? row.evidence : 'done'),
        ts: row.at, source: run,
      };
    case 'conductor.receipt':
      return conductorRowToMessage(k, row);
    case 'decision.made':
      return { k, type: 'receipt', text: stripMachineIds(textFor(row)), ts: row.at, source: run, jid: jidFor(row) };
    case 'forge.ask':
      return { ...event, text: `Asked you: ${stripMachineIds(String(row.question ?? ''))}` };
    case 'ask.answered':
      return { ...event, text: `You answered: ${stripMachineIds(String(row.answer ?? ''))}` };
    case 'run.parked':
      return { ...event, text: `Parked: ${humanizeParkReason(typeof row.reason === 'string' ? row.reason : 'waiting on you')}` };
    case 'warden.parked':
      return { ...event, text: `Parked by the warden: ${stripMachineIds(typeof row.reason === 'string' ? row.reason : 'a health check tripped')}` };
    case 'run.resumed':
      return { ...event, text: 'Resumed' };
    case 'run.relaunched': {
      const attempt = typeof row.attempt === 'number' ? row.attempt : null;
      return { ...event, text: attempt ? `Relaunched (attempt ${attempt})` : 'Relaunched' };
    }
    case 'permission.denied': {
      if (typeof row.reason !== 'string' || !row.reason) return null;
      // Item 4: a denial parked on the same ask a `run.parked`/`forge.ask` row already
      // named says nothing new -- the live thread read "Asked to use ToolSearch; parked
      // instead" as its own row right under the ask it was actually about.
      if (row.reason.startsWith('parking on')) return null;
      return { ...event, text: `Asked to use ${stripMachineIds(String(row.tool ?? 'a tool'))}; parked instead` };
    }
    case 'run.killed':
      return { ...event, text: `Killed: ${stripMachineIds(typeof row.reason === 'string' ? row.reason : 'no reason recorded')}` };
    case 'run.finished':
      return { ...event, text: `Finished: ${typeof row.verdict === 'string' ? row.verdict : 'unverified'}` };
    case 'run.handoff':
      return { ...event, text: 'Context ceiling reached; handed off to a fresh session' };
    // Item 6: a `note` row's own chip used to fall through to `plainEventText`'s
    // default, which read its raw `textFor` rendering ("note (S-…)") and stripped
    // only the id, leaving "note (this run)" -- a chip that names nothing. `message`
    // is the one field a note ever carries something worth saying in; a row with
    // none is dropped rather than shown as a bare, contentless "note" chip.
    case 'note':
      return typeof row.message === 'string' ? { ...event, text: `Note: ${stripMachineIds(row.message)}` } : null;
    default:
      return { ...event, text: plainEventText(row) };
  }
}

/** Deliverable 7: two consecutive replies whose first 80 characters match are the same
 *  report re-filed after a relaunch (the identical case that buried the worker's real
 *  updates under a wall of duplicate cards). The older is dropped and the newer keeps
 *  its own text with a note appended, so the thread reads as one report, not two. */
function foldRepeatedReplies(messages: Message[]): Message[] {
  const result: Message[] = [];
  let lastReplyIndex = -1;
  for (const message of messages) {
    if (message.type === 'reply' && lastReplyIndex >= 0) {
      const prevReply = result[lastReplyIndex]!;
      if (prevReply.text.slice(0, 80) === message.text.slice(0, 80)) {
        result.splice(lastReplyIndex, 1);
        result.push({ ...message, text: `${message.text} (repeated after a relaunch)` });
        lastReplyIndex = result.length - 1;
        continue;
      }
    }
    result.push(message);
    if (message.type === 'reply') lastReplyIndex = result.length - 1;
  }
  return result;
}

/** Item 4: a `run.parked` row read as an ask ("Parked: Asked you: X") and the actual
 *  `forge.ask` row it named ("Asked you: X") say the exact same thing when they land
 *  within 5s of each other -- the live thread showed both. The `run.parked` half is
 *  the one dropped: `forge.ask` is the row that answers, and its own "Asked you:" line
 *  is what a Resume/Kill or a click-to-answer card sits under. */
const PARK_ASK_WINDOW_MS = 5_000;
const PARKED_AS_ASK_PREFIX = 'Parked: Asked you: ';
const ASK_PREFIX = 'Asked you: ';

function foldParkedAskDuplicate(messages: Message[]): Message[] {
  const dropped = new Set<number>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (!message.text.startsWith(PARKED_AS_ASK_PREFIX)) continue;
    const rest = message.text.slice(PARKED_AS_ASK_PREFIX.length);
    const matchIndex = messages.findIndex((other, j) => (
      j !== i && other.text === `${ASK_PREFIX}${rest}` && Math.abs(other.ts - message.ts) <= PARK_ASK_WINDOW_MS
    ));
    if (matchIndex >= 0) dropped.add(i);
  }
  return messages.filter((_message, index) => !dropped.has(index));
}

/** Item 9: consecutive identical event lines (a relaunch storm, the same denial
 *  re-fired) collapse into one line with a count -- `Relaunched (x5)`, the way
 *  `collapseWardenChips` already collapses the rail's own warden-health chips. Only
 *  ever folds `event` messages, adjacent in the already-ordered stream: a `reply` or
 *  `activity` message keeps its own identity even when its text happens to repeat. */
const REPEAT_COUNT_SUFFIX = /\s\(x(\d+)\)$/;

function baseRepeatText(text: string): string {
  return text.replace(REPEAT_COUNT_SUFFIX, '');
}

function foldConsecutiveDuplicates(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    if (prev && prev.type === 'event' && message.type === 'event' && baseRepeatText(prev.text) === baseRepeatText(message.text)) {
      const priorCount = REPEAT_COUNT_SUFFIX.exec(prev.text)?.[1];
      const count = (priorCount ? Number(priorCount) : 1) + 1;
      result[result.length - 1] = { ...prev, ts: message.ts, text: `${baseRepeatText(prev.text)} (x${count})` };
      continue;
    }
    result.push(message);
  }
  return result;
}

function buildPlainRunMessages(run: string, own: ForgeEvent[]): Message[] {
  const messages: Message[] = [];
  let i = 0;
  while (i < own.length) {
    const row = own[i]!;
    if (BURST_EVENTS.has(row.event)) {
      const burst: ForgeEvent[] = [];
      while (i < own.length && BURST_EVENTS.has(own[i]!.event)) {
        burst.push(own[i]!);
        i += 1;
      }
      const message = activityMessageFor(run, burst);
      if (message) messages.push(message);
      continue;
    }
    const message = plainMessageFor(run, row);
    if (message) messages.push(message);
    i += 1;
  }
  return foldConsecutiveDuplicates(foldRepeatedReplies(foldParkedAskDuplicate(messages)));
}

export interface ComputeRunThreadOptions {
  /** `true` answers every one of the run's own journal rows unchanged, one message per
   *  row, the way `GET /run/:id/thread?verbose=1` always has. Default (unset/false):
   *  plain mode -- tool-call bursts fold into one `activity` sentence, every event
   *  reads as a clause a person can act on, and no message carries a machine id. */
  verbose?: boolean;
}

/**
 * `GET /run/:id/thread`: one run's own journal rows rendered as messages, plus whatever
 * `RunInbox` has queued for it -- read, never consumed, so the console showing this
 * thread never marks a message delivered before the run's own next tool call actually
 * does.
 */
export function computeRunThread(
  run: string, events: ForgeEvent[], runInboxMessages: RunMessage[], options: ComputeRunThreadOptions = {},
): { messages: Message[] } {
  const own = events.filter((row) => row.run === run);
  const rendered = options.verbose ? own.map((row) => runRowToMessage(run, row)) : buildPlainRunMessages(run, own);
  // An inbox message carries whatever the console queued for the run, question text
  // included; in plain mode it reads in words like every other row here.
  const inbox = runInboxMessages.map(runMessageToMessage).map((message) => (
    options.verbose ? message : { ...message, text: stripMachineIds(message.text) }
  ));
  return { messages: [...rendered, ...inbox].sort((a, b) => a.ts - b.ts) };
}
