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
import {
  appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, statSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

import { aliasOf, isKnownAlias, priceFor } from './policy.js';

export interface Usage {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export interface ForgeEvent {
  /** Unique per event, and what `cause` points at. */
  id: string;
  /** Position in this journal file, 1-based and stamped on append. Lets a reader ask
   *  for "the tail since seq N" without re-parsing everything before it. */
  seq: number;
  /** Milliseconds since the epoch, stamped on append. */
  at: number;
  /** The envelope's schema version, stamped on append. A row with no `seq`/`version`
   *  predates this field and is read as version 0, never quarantined for lacking it. */
  version: number;
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
  /** The model-policy class this run opened under, for liveness's context ceiling. */
  className?: string;
  /** When this run last produced any journal event, for liveness's idle signal. */
  lastEventAt: number;
  /** The ask key this run is parked on, while `state` is `'parked'`. */
  parkKey?: string;
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
  /** Model ids usage was reported under that this policy has no price for. Billed
   *  nothing, named here rather than folded silently into burn at a guessed rate. */
  unknownModels: string[];
}

/** The highest `seq` already on disk, or 0 for a file with none (empty, missing, or
 *  written before this field existed). The next row's seq is always one past this. */
function maxSeqOnDisk(path: string): number {
  if (!existsSync(path)) return 0;
  let max = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { seq?: unknown };
      if (typeof row.seq === 'number' && row.seq > max) max = row.seq;
    } catch {
      // A torn or corrupt line carries no usable seq; it does not move the count.
    }
  }
  return max;
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

  /** Cached once per instance, from whatever the file already holds, so a fresh
   *  `Journal` opened on an existing file keeps counting forward rather than
   *  restarting at 1 and colliding with rows already on disk. */
  private lastSeq: number | undefined;

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
    if (this.lastSeq === undefined) this.lastSeq = maxSeqOnDisk(this.path);
    this.lastSeq += 1;
    const row: ForgeEvent = {
      id: randomUUID(),
      at: Date.now(),
      event: 'note',
      actor: 'runner',
      ...event,
      // Stamped last, and unconditionally: a caller cannot buy its way past the
      // monotonic count by passing its own seq or version in `event`.
      seq: this.lastSeq,
      version: 1,
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

/** Append one event without holding a handle. For callers that write rarely. Re-reads
 *  the file to find the next seq each time, which is fine at the call rate this is used
 *  for (see `gotcha.ts`) and keeps this free of the instance state `Journal` needs for
 *  its hot path. */
export function appendOnce(path: string, event: Partial<ForgeEvent>): ForgeEvent {
  const row: ForgeEvent = {
    id: randomUUID(), at: Date.now(), event: 'note', actor: 'runner', ...event,
    seq: maxSeqOnDisk(path) + 1,
    version: 1,
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

function emptyState(): FleetState {
  return { events: [], runs: {}, burn: {}, handoffs: 0, torn: 0, unknownModels: [] };
}

/** One line folded into `state`. Shared by `replay()` and `JournalCache`, so a full parse
 *  and an incremental one can never learn different lessons from the same line. */
function foldLine(state: FleetState, line: string): void {
  if (!line.trim()) return;
  let row: ForgeEvent;
  try {
    row = JSON.parse(line) as ForgeEvent;
  } catch {
    state.torn += 1;
    return;
  }
  state.events.push(row);

  if (row.usage) {
    const alias = aliasOf(row.model ?? '');
    if (!isKnownAlias(alias)) {
      // Billed nothing rather than at whatever priceFor's fallback used to guess: the
      // model itself is named here so a person can add it to model-policy.json instead
      // of the fallback rate quietly becoming the answer for every reroute like it.
      if (!state.unknownModels.includes(row.model ?? alias)) state.unknownModels.push(row.model ?? alias);
    } else {
      const spent = costOf(row.usage, alias);
      state.burn[alias] = (state.burn[alias] ?? 0) + spent;
      if (row.run) runOf(state, row.run).costUsd += spent;
    }
  }
  if (!row.run) return;
  const run = runOf(state, row.run);
  run.lastEventAt = row.at;

  switch (row.event) {
      case 'run.started':
        run.state = 'started';
        if (row.ticket) run.ticket = row.ticket;
        if (row.model) run.model = row.model;
        if (row.predecessor) run.predecessor = row.predecessor;
        if (typeof row['className'] === 'string') run.className = row['className'];
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
        delete run.currentTool;
        break;
      case 'run.parked':
        run.state = 'parked';
        if (row.verdict) run.verdict = row.verdict;
        if (typeof row['key'] === 'string') run.parkKey = row['key'];
        delete run.currentTool;
        break;
      case 'run.resumed':
        run.state = 'started';
        delete run.parkKey;
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

/**
 * Rebuild the fleet's state from its journal.
 *
 * Every branch here is a fold over events in the order they were written. Nothing reads
 * the world: two replays of the same file give the same answer, which is what makes a
 * restart honest rather than a fresh guess.
 */
export function replay(path: string): FleetState {
  const state = emptyState();
  if (!existsSync(path)) return state;
  for (const line of readFileSync(path, 'utf8').split('\n')) foldLine(state, line);
  return state;
}

/** Reads a byte range from a file. The one seam `JournalCache` uses, so a specimen can
 *  count exactly how many bytes a read actually touched. */
export interface RangeReader {
  size(path: string): number;
  readRange(path: string, start: number, end: number): string;
}

const defaultRangeReader: RangeReader = {
  size: (path) => (existsSync(path) ? statSync(path).size : 0),
  readRange: (path, start, end) => {
    if (end <= start) return '';
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(end - start);
      readSync(fd, buffer, 0, end - start, start);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  },
};

/**
 * `replay()`'s incremental twin.
 *
 * `/state` on 4120 and the 30-second liveness tick both call this on the same journal
 * repeatedly, and the journal only grows: re-parsing the whole file on every call is work
 * that scales with how long the fleet has been running, for state that has not changed
 * except at the tail. This instead remembers how many bytes it has already folded and
 * reads only what was appended since, folding those lines into the same running state.
 *
 * A file that got smaller than the last read (rotated, truncated) is treated as a new
 * journal: starting over here is honest, where trying to resume from a stale offset into
 * different bytes would not be.
 */
export class JournalCache {
  private offset = 0;

  private state: FleetState = emptyState();

  private carry = '';

  constructor(private readonly reader: RangeReader = defaultRangeReader) {}

  read(path: string): FleetState {
    const size = this.reader.size(path);
    if (size < this.offset) {
      this.offset = 0;
      this.state = emptyState();
      this.carry = '';
    }
    if (size > this.offset) {
      const chunk = this.carry + this.reader.readRange(path, this.offset, size);
      this.offset = size;
      const lines = chunk.split('\n');
      // The last entry is kept back rather than folded: it may be a line the writer has
      // not finished yet, and the next read's bytes complete it.
      this.carry = lines.pop() ?? '';
      for (const line of lines) foldLine(this.state, line);
    }
    return this.state;
  }
}
