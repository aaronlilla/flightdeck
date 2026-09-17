/**
 * Whether a lane's own worker is actually there right now (`GET /lanes`'s `live`
 * field), as distinct from `state`, which is folded from the journal and only ever
 * says what the run last reported about itself. `state` can say `running` for a
 * process that has already died; `live` is the fresh, cheap check that catches that.
 *
 * `alive` reuses `processAlive` (`registry.ts`), the one place this runner already
 * asks "is this pid still there" -- never a second definition of alive.
 */
import type { FleetState, RunState } from '../journal.js';
import type { RegistryRecord } from '../registry.js';
import { processAlive, runHasWorker } from '../registry.js';
import type { LaneLive, QueueItem } from '../../shared/console-model.js';
import { ticketFor } from './lanes.js';

/**
 * `run`, with its own trailing handoff-attempt suffix (`-2`, `-3`, ...) stripped, when
 * it has one. A trailing `-<digits>` is only ever an attempt suffix, never accepted as
 * one, when stripping it would still leave the run's own ticket key intact --
 * `queue-BBZ-182-2` strips to `queue-BBZ-182` (ticket `BBZ-182` survives), but
 * `queue-BBZ-96` does not strip at all, because "96" is the ticket's own number and
 * stripping it would cut `BBZ-96` in half.
 */
export function baseRunKey(run: string): string {
  const ticket = ticketFor(run, undefined);
  if (!ticket) return run;
  const match = /^(.*)-\d+$/.exec(run);
  if (!match) return run;
  const candidate = match[1] as string;
  return candidate.toUpperCase().includes(ticket) ? candidate : run;
}

/** `run` plus every key in `knownKeys` that shares its base once a trailing
 *  handoff-attempt suffix is stripped -- what `lastEventAt` reads across. */
export function handoffSiblingKeys(run: string, knownKeys: Iterable<string>): string[] {
  const base = baseRunKey(run);
  const suffixed = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
  const out = new Set<string>([run]);
  for (const key of knownKeys) {
    if (key === base || suffixed.test(key)) out.add(key);
  }
  return [...out];
}

/** The newest `RunState.lastEventAt` across `run` and its handoff-attempt siblings, or
 *  `null` when the journal has folded no run state for any of them yet. */
/** Actors whose journal rows mean the run itself did something: the worker's own tool
 *  calls and turns, and the runner that starts and hands it off. Rows from the warden,
 *  governor, console or chain are bookkeeping about a run, written even for runs that
 *  finished days ago (every `forge up` restart re-fires `burn.mismatch`, for one), and
 *  must never make a finished lane read as working. */
const WORK_ACTORS = new Set(['worker', 'runner']);

export function lastEventAtFor(run: string, fleet: Pick<FleetState, 'events' | 'runs'>): number | null {
  const keys = new Set(handoffSiblingKeys(run, Object.keys(fleet.runs)));
  let newest: number | null = null;
  for (const row of fleet.events) {
    if (!row.run || !keys.has(row.run) || !WORK_ACTORS.has(row.actor)) continue;
    if (newest === null || row.at > newest) newest = row.at;
  }
  return newest;
}

/** Journal run states a worker can still be behind. Every other state is an ending. */
const OPEN_RUN_STATES: ReadonlySet<RunState['state']> = new Set(['started', 'paused', 'handed-off']);

/** The journal's state for `run`, following its handoff successors to the newest one the
 *  journal has folded, or `null` when the journal has never seen the run. */
export function runStateFor(run: string, fleet: Pick<FleetState, 'runs'>): RunState['state'] | null {
  let key = run;
  let row = fleet.runs[key];
  const seen = new Set<string>();
  while (row?.successor && !seen.has(key)) {
    seen.add(key);
    const next = fleet.runs[row.successor];
    if (!next) break;
    key = row.successor;
    row = next;
  }
  return row?.state ?? null;
}

export interface ComputeLiveDeps {
  fleet: FleetState;
  registryGet: (run: string) => RegistryRecord | undefined;
  isAlive?: (pid: number) => boolean;
}

/** `GET /lanes`'s `live` field for one run: `alive` off the registry's own pid for
 *  this run, checked fresh (never off `state`, which the warden owns); `pid` the same
 *  registry row's pid, or `null` with none on record; `lastEventAt` the newest journal
 *  event across the run and its handoff-attempt siblings; `checkedAt` the moment this
 *  ran. A lane whose registry row is gone (the ordinary case for anything not
 *  currently running) reads `alive: false, pid: null` rather than throwing. */
export function computeLive(run: string, deps: ComputeLiveDeps, now: number): LaneLive {
  const isAlive = deps.isAlive ?? processAlive;
  const registryRow = deps.registryGet(run);
  const pid = registryRow?.pid ?? null;
  const lastEventAt = lastEventAtFor(run, deps.fleet);
  // A run resumed by the console's reconcile keeps its old registry pid while a new
  // worker does the work, so the pid alone under-reports; fresh journal events count too,
  // unless the journal already records the run as ended (`runHasWorker`).
  const state = runStateFor(run, deps.fleet);
  const alive = runHasWorker({
    pid, isAlive, lastWorkAt: lastEventAt, ended: state !== null && !OPEN_RUN_STATES.has(state),
    now, quietMs: RECENT_EVENT_MS,
  });
  return { alive, pid, lastEventAt, checkedAt: now };
}

/** How long after its last journal event a run still counts as working. */
export const RECENT_EVENT_MS = 90_000;

/** What a queue item's run is doing at read time: `computeLive`'s answer plus the
 *  journal's own state for it. */
export interface QueueRunReading extends LaneLive {
  runState: RunState['state'] | null;
  /** Whether `pid` itself is alive. A run can read live from fresh work rows alone, and a
   *  card naming a dead pid points a person at a process that does not exist. */
  pidAlive?: boolean;
}

export function readQueueRun(runKey: string, deps: ComputeLiveDeps, now: number): QueueRunReading {
  const live = computeLive(runKey, deps, now);
  return { ...live, runState: runStateFor(runKey, deps.fleet), pidAlive: live.pid !== null && (deps.isAlive ?? processAlive)(live.pid) };
}

/** How long a run with a dead pid must write no work row before its `running` item reads
 *  parked. Far longer than `RECENT_EVENT_MS`: the journal writes one row when a tool call
 *  starts and one when it ends, so a resumed worker inside a long build is silent the whole
 *  time. Shape 3 (Q-fdeab07a) sat silent for twenty-four minutes. A kill does not wait. */
export const ORPHAN_SILENCE_MS = 15 * 60_000;

/** The sentence a queue card and a refused retry both carry for a run that is working. */
export function liveRunReason(runKey: string, pid: number | null): string {
  return pid !== null
    ? `run ${runKey} is still running as pid ${pid}`
    : `run ${runKey} is still writing work rows with no pid on record`;
}

/** Stored states a working run contradicts. */
const STOPPED_QUEUE_STATES: ReadonlySet<QueueItem['state']> = new Set(['parked', 'failed', 'queued']);

/** Run states the read leaves a `running` item alone in. `finished` and `parked` are endings
 *  the queue's own gate hop routes on its next tick, to review or to a park carrying the
 *  gate's reason. `paused` waits on a resume and `handed-off` on a successor the journal has
 *  not folded yet: neither is an orphan, and reading one parked would offer a Retry that
 *  launches a second worker on the same worktree. */
const NOT_ORPHANED_RUN_STATES: ReadonlySet<RunState['state']> = new Set(['finished', 'parked', 'paused', 'handed-off']);

/**
 * A queue item as a person should see it: its stored state checked against its run at
 * read time. A working run is never shown parked, failed or queued. A `running` item whose
 * run was killed, or has no process and no recent work at all, reads `parked`, so Retry and
 * Remove act on it without anyone editing the store by hand. Nothing is written here.
 */
export function deriveQueueItem(item: QueueItem, reading: QueueRunReading | undefined): QueueItem {
  if (!item.runKey || !reading) return item;
  if (reading.alive) {
    return STOPPED_QUEUE_STATES.has(item.state)
      ? { ...item, state: 'running', reason: liveRunReason(item.runKey, reading.pidAlive ? reading.pid : null) }
      : item;
  }
  if (item.state !== 'running') return item;
  if (reading.runState !== null && NOT_ORPHANED_RUN_STATES.has(reading.runState)) return item;
  // A run killed after its PR was up still goes to the gate, which keeps the item `running`
  // while checks are pending. An item carrying its PR or a pending-checks streak is the gate's.
  if (item.pr || (item.pendingGatePolls ?? 0) > 0) return item;
  if (reading.runState !== 'killed' && reading.lastEventAt !== null
    && reading.checkedAt - reading.lastEventAt < ORPHAN_SILENCE_MS) return item;
  const how = reading.runState === 'killed' ? 'was killed and has' : 'has';
  return { ...item, state: 'parked', reason: `run ${item.runKey} ${how} no live process` };
}
