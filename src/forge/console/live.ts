/**
 * Whether a lane's own worker is actually there right now (`GET /lanes`'s `live`
 * field), as distinct from `state`, which is folded from the journal and only ever
 * says what the run last reported about itself. `state` can say `running` for a
 * process that has already died; `live` is the fresh, cheap check that catches that.
 *
 * `alive` reuses `processAlive` (`registry.ts`), the one place this runner already
 * asks "is this pid still there" -- never a second definition of alive.
 */
import type { FleetState } from '../journal.js';
import type { RegistryRecord } from '../registry.js';
import { processAlive } from '../registry.js';
import type { LaneLive } from '../../shared/console-model.js';
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
  // worker does the work, so the pid alone under-reports. Fresh journal events are
  // direct evidence of work; either signal makes the lane live.
  const recentEvent = lastEventAt !== null && now - lastEventAt <= RECENT_EVENT_MS;
  const alive = (pid !== null && isAlive(pid)) || recentEvent;
  return { alive, pid, lastEventAt, checkedAt: now };
}

/** How long after its last journal event a run still counts as working. */
export const RECENT_EVENT_MS = 90_000;
