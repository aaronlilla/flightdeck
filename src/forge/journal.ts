/**
 * Append-only memory for the whole fleet.
 *
 * Every fact the runner learns becomes one JSON line, fsynced before the write returns.
 * State is `replay(journal)` and nothing else is authoritative, so the interesting
 * failure is a process killed mid-write: the file ends with half a line. A reader that
 * throws on that loses every event before it as well, which turns one lost turn into a
 * lost day. So a line that will not parse is counted and skipped, and the count travels
 * with the state instead of being swallowed.
 *
 * Each event carries `cause`, the id of the event it answers. That chain is the
 * provenance graph: a ticket sheet can walk it from a Sentry issue to a merged pull
 * request without anybody writing the link down twice.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { aliasOf, priceFor } from './policy.js';

export interface Usage {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export interface ForgeEvent {
  /** Unique per event, and what `cause` points at. */
  id: string;
  /** Milliseconds since the epoch, stamped on append. */
  at: number;
  /** What happened: run.started, turn.end, run.handoff, ask.raised, usage, and so on. */
  event: string;
  /** Who says so: runner, worker, warden, console, master. */
  actor: string;
  /** The run this belongs to, when it belongs to one. */
  run?: string;
  ticket?: string;
  /** The id of the event this one answers. */
  cause?: string;
  model?: string;
  usage?: Usage;
  context?: number;
  verdict?: string;
  successor?: string;
  predecessor?: string;
  [key: string]: unknown;
}

export interface RunState {
  run: string;
  state: 'started' | 'finished' | 'handed-off' | 'paused' | 'parked';
  ticket?: string;
  verdict?: string;
  turns: number;
  context: number;
  costUsd: number;
  model?: string;
  successor?: string;
  predecessor?: string;
  /** When this run last produced any journal event, for liveness's idle signal. */
  lastEventAt: number;
  /** The tool call in flight, when the last event named one and none has closed it since. */
  currentTool?: { name: string; startedAt: number };
}

export interface FleetState {
  events: ForgeEvent[];
  runs: Record<string, RunState>;
  /** Dollars of list-equivalent per tier alias, added up from every usage event. */
  burn: Record<string, number>;
  handoffs: number;
  /** Lines that would not parse. Reported, never silently dropped. */
  torn: number;
}

/**
 * A writer that fsyncs each line.
 *
 * Held open rather than reopened per append, because the fsync is the expensive part and
 * a worker writes a row per tool call. `close()` is not optional: a handle left open on
 * Windows keeps the file locked against the reader in the same process.
 */
export class Journal {
  private fd: number | undefined;

  constructor(private readonly path: string) {}

  private handle(): number {
    if (this.fd === undefined) {
      // 'a' rather than 'w': a torn journal is appended to, never truncated. The half
      // line stays on disk as evidence and replay counts it.
      this.fd = openSync(this.path, 'a');
      if (this.needsNewline()) writeSync(this.fd, '\n');
    }
    return this.fd;
  }

  /**
   * True when the file ends mid-line.
   *
   * Appending straight onto a torn line would glue the crash's fragment to the next
   * event and lose both. One newline first costs nothing and keeps the damage to the
   * line that was actually interrupted.
   */
  private needsNewline(): boolean {
    if (!existsSync(this.path)) return false;
    const text = readFileSync(this.path, 'utf8');
    return text.length > 0 && !text.endsWith('\n');
  }

  append(event: Partial<ForgeEvent>): ForgeEvent {
    const row: ForgeEvent = {
      id: randomUUID(),
      at: Date.now(),
      event: 'note',
      actor: 'runner',
      ...event,
    } as ForgeEvent;
    const fd = this.handle();
    writeSync(fd, JSON.stringify(row) + '\n');
    fsyncSync(fd);
    return row;
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}

/** Append one event without holding a handle. For callers that write rarely. */
export function appendOnce(path: string, event: Partial<ForgeEvent>): ForgeEvent {
  const row: ForgeEvent = {
    id: randomUUID(), at: Date.now(), event: 'note', actor: 'runner', ...event,
  } as ForgeEvent;
  appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function costOf(usage: Usage, alias: string): number {
  const price = priceFor(alias);
  return (usage.input * price.input
    + usage.cacheRead * price.cacheRead
    + usage.cacheCreation * price.cacheWrite
    + usage.output * price.output) / 1e6;
}

function runOf(state: FleetState, name: string): RunState {
  const found = state.runs[name];
  if (found) return found;
  const created: RunState = {
    run: name, state: 'started', turns: 0, context: 0, costUsd: 0, lastEventAt: 0,
  };
  state.runs[name] = created;
  return created;
}

/**
 * Rebuild the fleet's state from its journal.
 *
 * Every branch here is a fold over events in the order they were written. Nothing reads
 * the world: two replays of the same file give the same answer, which is what makes a
 * restart honest rather than a fresh guess.
 */
export function replay(path: string): FleetState {
  const state: FleetState = { events: [], runs: {}, burn: {}, handoffs: 0, torn: 0 };
  if (!existsSync(path)) return state;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: ForgeEvent;
    try {
      row = JSON.parse(line) as ForgeEvent;
    } catch {
      state.torn += 1;
      continue;
    }
    state.events.push(row);

    if (row.usage) {
      const alias = aliasOf(row.model ?? '');
      const spent = costOf(row.usage, alias);
      state.burn[alias] = (state.burn[alias] ?? 0) + spent;
      if (row.run) runOf(state, row.run).costUsd += spent;
    }
    if (!row.run) continue;
    const run = runOf(state, row.run);
    run.lastEventAt = row.at;

    switch (row.event) {
      case 'run.started':
        run.state = 'started';
        if (row.ticket) run.ticket = row.ticket;
        if (row.model) run.model = row.model;
        if (row.predecessor) run.predecessor = row.predecessor;
        break;
      case 'turn.end':
        run.turns += 1;
        if (typeof row.context === 'number') run.context = row.context;
        delete run.currentTool;
        break;
      case 'run.handoff':
        run.state = 'handed-off';
        if (row.successor) run.successor = row.successor;
        state.handoffs += 1;
        delete run.currentTool;
        break;
      case 'run.finished':
        run.state = 'finished';
        if (row.verdict) run.verdict = row.verdict;
        delete run.currentTool;
        break;
      case 'run.paused':
        run.state = 'paused';
        break;
      case 'run.parked':
        run.state = 'parked';
        if (row.verdict) run.verdict = row.verdict;
        delete run.currentTool;
        break;
      case 'tool.start':
        run.currentTool = { name: String(row['tool'] ?? ''), startedAt: row.at };
        break;
      case 'tool.end':
        delete run.currentTool;
        break;
      default:
        break;
    }
  }
  return state;
}
