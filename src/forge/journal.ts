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
  state: 'started' | 'finished' | 'handed-off' | 'paused' | 'parked' | 'killed';
  ticket?: string;
  verdict?: string;
  turns: number;
  context: number;
  costUsd: number;
  /** Real cumulative tokens (input + output + cache read + cache write) across every
   *  usage row this run has journaled -- the board's own honest total, tracked whether
   *  or not the model is one this policy has a price for. `journal.ts`'s `costUsd`
   *  answers "what would this cost at list price"; this answers "how many tokens did
   *  this run actually use", which is the number the console shows instead of a dollar
   *  figure this fleet's flat subscription never actually spends. */
  tokensUsed: number;
  model?: string;
  successor?: string;
  predecessor?: string;
  /** The registry id (`~/.forge/accounts.json`) of the login this run launched under,
   *  from its `run.started` row. Absent for rows written before attribution existed. */
  account?: string;
  /** The model-policy class this run opened under, for liveness's context ceiling. */
  className?: string;
  /** When this run last produced any journal event, for liveness's idle signal. */
  lastEventAt: number;
  /** The ask key this run is parked on, while `state` is `'parked'`. */
  parkKey?: string;
  /** When a `run.paused` row (the Governor's window pause) names one: milliseconds since
   *  the epoch, the earliest this run may be admitted again. */
  resumeAt?: number;
  /** The tool call in flight, when the last event named one and none has closed it since. */
  currentTool?: { name: string; startedAt: number; cls?: string };
  /** Cumulative `usage.cacheRead` across every turn, for the Warden's cost-shape check
   *  (P4.7/I2). Zero for a run that has journaled no usage yet, never undefined. */
  cacheReadTokens: number;
  /** Cumulative `usage.input + usage.cacheRead` across every turn, the denominator for
   *  the cache-read ratio `assessCostShape` compares against `WardenConfig.cacheReadRatio`. */
  totalReadTokens: number;
  /** Turns since the last Edit/Write/NotebookEdit tool call closed, for `assessCostShape`'s
   *  "no write tool call in a long while" leg. A run that has taken no turn yet reads 0. */
  turnsSinceWrite: number;
}

/** Tool names `turnsSinceWrite` treats as a write: the ones the roadmap's cost-shape
 *  example means by "a write tool call" (a file actually changed on disk). `Bash` is
 *  deliberately excluded -- it is as often a read (`git status`, a test run) as a write,
 *  and guessing from its command text would be exactly the kind of fragile classifier
 *  order 6 warns against for a signal this consequential. */
const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit']);

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

  /** The file this instance appends to. Exposed so a caller that only holds the
   *  `Journal` (never the raw path it was opened with) can still `replay()` it -- a
   *  reconcile pass reading its own journal for a prior verdict, say, rather than
   *  needing a second path threaded through just for that read. */
  get filePath(): string {
    return this.path;
  }

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

/** Exported so `console/cost-steps.ts` can price one turn's usage the same way `replay`
 *  prices a run's total, instead of a second pricing formula drifting from this one. */
export function costOf(usage: Usage, alias: string): number {
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
    run: name, state: 'started', turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0,
    cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0,
  };
  state.runs[name] = created;
  return created;
}

function emptyState(): FleetState {
  return { events: [], runs: {}, burn: {}, handoffs: 0, torn: 0, unknownModels: [] };
}

/** Per-run "a write tool call closed since the last turn ended" flag, kept off `RunState`
 *  itself (which is public and replayed wholesale by callers) rather than as a field
 *  everyone reading a `RunState` would otherwise have to know to ignore. Keyed by the
 *  `FleetState` instance so two folds in the same process never share bookkeeping. */
const wroteSinceLastTurn = new WeakMap<FleetState, Set<string>>();

function markWrote(state: FleetState, run: string): void {
  let set = wroteSinceLastTurn.get(state);
  if (!set) {
    set = new Set();
    wroteSinceLastTurn.set(state, set);
  }
  set.add(run);
}

function consumeWrote(state: FleetState, run: string): boolean {
  const set = wroteSinceLastTurn.get(state);
  if (!set || !set.has(run)) return false;
  set.delete(run);
  return true;
}

/**
 * True when `row` looks like the SDK's own per-block repeat of `prev` rather than a
 * second, genuine usage event: same run, same model, all four usage numbers identical,
 * and close enough in time that it is almost certainly the same turn's usage object
 * seen twice (23.1% of `subagent.usage` rows in a real fleet.jsonl were exact repeats
 * of the row immediately before them, within milliseconds). The 5-second window is a
 * heuristic, not a proof: two genuinely identical consecutive turns landing inside 5s
 * of each other would also be merged by this check.
 */
export function isRepeatedUsageRow(prev: ForgeEvent | undefined, row: ForgeEvent): boolean {
  if (!prev || !prev.usage || !row.usage) return false;
  if (prev.run !== row.run || prev.model !== row.model) return false;
  if (prev.usage.input !== row.usage.input) return false;
  if (prev.usage.cacheRead !== row.usage.cacheRead) return false;
  if (prev.usage.cacheCreation !== row.usage.cacheCreation) return false;
  if (prev.usage.output !== row.usage.output) return false;
  return Math.abs(row.at - prev.at) < 5_000;
}

/** Last usage-carrying row seen per run, per `FleetState`, so `foldLine` can tell a
 *  genuine second usage event from the SDK's own per-block repeat of the first. Kept
 *  out of `FleetState` itself (like `wroteSinceLastTurn`) so it never becomes part of
 *  the state a caller can inspect or serialize. */
const lastUsageRowByRun = new WeakMap<FleetState, Map<string, ForgeEvent>>();

function lastUsageRow(state: FleetState, run: string): ForgeEvent | undefined {
  return lastUsageRowByRun.get(state)?.get(run);
}

function setLastUsageRow(state: FleetState, run: string, row: ForgeEvent): void {
  let map = lastUsageRowByRun.get(state);
  if (!map) {
    map = new Map();
    lastUsageRowByRun.set(state, map);
  }
  map.set(run, row);
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
    // The SDK repeats one turn's usage object across every content-block message it
    // sends for that turn; the adapter now dedupes its own live `usage` events for
    // this reason (see `src/adapter/engine.ts`), but rows already on disk from before
    // that fix -- and any other producer of `usage`/`subagent.usage` rows -- still need
    // the same skip on replay, or the fold double-counts what the block repeat wrote.
    const repeated = row.run ? isRepeatedUsageRow(lastUsageRow(state, row.run), row) : false;
    if (row.run) setLastUsageRow(state, row.run, row);
    if (!repeated) {
      const alias = aliasOf(row.model ?? '');
      // Real tokens moved whether or not this policy has a price for the model that
      // billed them -- `tokensUsed` is the board's own honest total and never waits on
      // a price table the way `costUsd`/`burn` (list-price-equivalent, still useful for
      // the Governor's own dollar-denominated admission checks) do.
      const tokensThisRow = row.usage.input + row.usage.cacheRead + row.usage.cacheCreation + row.usage.output;
      if (row.run) runOf(state, row.run).tokensUsed += tokensThisRow;
      if (!isKnownAlias(alias)) {
        // Billed nothing rather than at whatever priceFor's fallback used to guess: the
        // model itself is named here so a person can add it to model-policy.json instead
        // of the fallback rate quietly becoming the answer for every reroute like it.
        if (!state.unknownModels.includes(row.model ?? alias)) state.unknownModels.push(row.model ?? alias);
      } else {
        const spent = costOf(row.usage, alias);
        state.burn[alias] = (state.burn[alias] ?? 0) + spent;
        if (row.run) {
          const run = runOf(state, row.run);
          run.costUsd += spent;
          run.cacheReadTokens += row.usage.cacheRead;
          run.totalReadTokens += row.usage.input + row.usage.cacheRead;
        }
      }
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
        if (typeof row['account'] === 'string') run.account = row['account'];
        break;
      case 'turn.end':
        run.turns += 1;
        run.turnsSinceWrite = consumeWrote(state, row.run) ? 0 : run.turnsSinceWrite + 1;
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
        // The Governor's window pause (P4.2, `governor.ts`'s `WindowGate`) stamps a
        // resume time so a reader (the console, or a resume check) knows when to try
        // this run again without re-deriving the reset window itself.
        if (typeof row['resumeAt'] === 'number') run.resumeAt = row['resumeAt'];
        delete run.currentTool;
        break;
      case 'run.parked':
      // The Governor's own two park kinds (P4.2, `governor.ts`): `warden.parked` for a
      // per-turn model-mismatch (the Warden actuator path) and `governor.parked` for a
      // budget-cap refusal. Both fold exactly like `run.parked` so a reader sees the park
      // immediately either way; `reason` (carried on the row, not read here) is what
      // tells the two apart.
      case 'warden.parked':
      case 'governor.parked':
        run.state = 'parked';
        if (row.verdict) run.verdict = row.verdict;
        if (typeof row['key'] === 'string') run.parkKey = row['key'];
        delete run.currentTool;
        break;
      case 'run.resumed':
        run.state = 'started';
        delete run.parkKey;
        break;
      case 'run.killed':
        // Terminal, and never overwritten by anything folded after it in this same
        // pass: `laneStateFor` (console/lanes.ts) already reads a run's own last event
        // for exactly this reason, but `RunState.state` itself used to have no `killed`
        // value at all, so a kill left the fold's own state stuck on whatever it was
        // before, "started" for a run that was mid-turn. A `forge up` that resumes a
        // stale registry row despite this (the bug `reconcileRegistry` now refuses) used
        // to compound that: the resume's own fresh events pushed `run.killed` out of
        // being the run's last event, and with no `killed` state to fall back on, the
        // fold read the run as plain `running` forever, with no process behind it.
        run.state = 'killed';
        delete run.currentTool;
        break;
      case 'tool.start': {
        const toolName = String(row['tool'] ?? '');
        const cls = typeof row['cls'] === 'string' ? row['cls'] : undefined;
        run.currentTool = { name: toolName, startedAt: row.at, ...(cls ? { cls } : {}) };
        if (WRITE_TOOL_NAMES.has(toolName)) markWrote(state, row.run);
        break;
      }
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
