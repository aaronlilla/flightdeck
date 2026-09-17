/**
 * `retire.ts` (H1.7): which lanes may leave the board's default view, and the
 * append-only log (`~/.forge/console/retired.jsonl`) that remembers which ones have.
 * Retiring never deletes anything -- `GET /lanes?archived=1` still finds a retired lane,
 * and unretiring is one more row, never an edit to the one that came before it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { appendOnce } from '../journal.js';
import type { Lane } from '../../shared/console-model.js';

export function retiredPath(forgeHomeDir: string): string {
  return join(forgeHomeDir, 'console', 'retired.jsonl');
}

const FINISHED_PROBE_STATES = new Set<Lane['state']>(['done', 'unverified', 'exhausted']);

/** Whether a run is over by the journal's own definition -- shared with R-61 item 1's
 *  final PR re-check, which must only ever fire for a lane that is actually finished,
 *  never one still running/parked/blocked. */
export function laneFinished(lane: Lane): boolean {
  const finishedProbe = lane.kind === 'probe' && FINISHED_PROBE_STATES.has(lane.state);
  return lane.state === 'done' || lane.state === 'merged' || lane.state === 'killed'
    || lane.state === 'unverified' || finishedProbe;
}

/** Whether a lane is a candidate for `POST /run/:id/retire` or `POST /retire-finished`:
 *  done, merged, killed or unverified outright (a finished probe counts on `exhausted`
 *  too), with no unmerged PR still open on it and no live process behind it. A lane
 *  failing any of these stays on the board -- retiring is never a way to make an
 *  unresolved lane disappear.
 *
 *  `unverified` counts for every kind, not probes alone: it is what a `run.finished`
 *  row folds to when its verdict is neither done nor exhausted nor killed, so the run
 *  is over by the journal's own definition. Seen live 2026-09-08: a manual run that
 *  ended `unverified` with no PR had no exit at all -- Kill, Reopen and Verify each
 *  refused it, and Clean up skipped it, so the card could never leave the board.
 *  `exhausted` stays probe-only, since Kill and Reopen both still reach a non-probe
 *  exhausted run. */
export function retireEligible(lane: Lane): boolean {
  if (!laneFinished(lane)) return false;
  // R-61 item 2: a PR closed without merging (abandoned work, `gh`'s own `state ===
  // 'CLOSED'`) is finished-with-a-verdict too, exactly like a merged one -- only a
  // genuinely still-open PR (`merged: false`, `closed` not true) keeps the lane on
  // the board.
  if (lane.pr && !lane.pr.merged && !lane.pr.closed) return false;
  if (lane.heart) return false;
  return true;
}

interface RetireRow {
  id: string;
  at: number;
  retiredAt: number | null;
}

function rows(path: string): RetireRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as RetireRow);
}

/** Every lane this log has ever retired, folded to its latest word: `id -> retiredAt`.
 *  A lane later unretired is simply absent from the map, never present with a `null`. */
export function readRetired(path: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows(path)) {
    if (row.retiredAt === null) map.delete(row.id);
    else map.set(row.id, row.retiredAt);
  }
  return map;
}

function appendRow(path: string, row: RetireRow): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
}

export function retireRun(path: string, id: string, now: number): void {
  appendRow(path, { id, at: now, retiredAt: now });
}

export function unretireRun(path: string, id: string, now: number): void {
  appendRow(path, { id, at: now, retiredAt: null });
}

/** `POST /retire-finished`: retires every eligible lane not already retired, and
 *  returns the ids it actually retired -- never a lane already off the board, and
 *  never one this call's own eligibility check refuses. */
export function retireFinished(path: string, lanes: Lane[], now: number): string[] {
  const already = readRetired(path);
  const retired: string[] = [];
  for (const lane of lanes) {
    if (already.has(lane.id)) continue;
    if (!retireEligible(lane)) continue;
    retireRun(path, lane.id, now);
    retired.push(lane.id);
  }
  return retired;
}

/** `GET /retire-finished`: what `retireFinished` would touch, with nothing retired --
 *  the same eligibility rule, read-only, for the preview the console shows before the
 *  operator confirms the bulk action. */
export function retirePreview(path: string, lanes: Lane[]): { id: string; title: string | null }[] {
  const already = readRetired(path);
  return lanes
    .filter((lane) => !already.has(lane.id) && retireEligible(lane))
    .map((lane) => ({ id: lane.id, title: lane.title }));
}

export interface RetireLaneDeps {
  forgeHomeDir: string;
  journalPath: string;
  /** The archived-inclusive lanes view (`ConsoleReads.lanesResponse(true, true)`), the
   *  one the eligibility rule reads a lane's heart and PR off. */
  lanesAll: () => Lane[];
  now?: () => number;
}

export type RetireLaneOutcome =
  | { status: 200; body: { ok: true; jid: null; message: string; undoable: boolean } }
  | { status: 404 | 409; body: { error: string } };

/**
 * The one implementation behind `POST /run/:id/retire` / `unretire`, the rail's typed
 * `remove | archive | retire <lane>` and the Conductor agent's `retire` / `unretire`
 * tools (2026-09-08). Retiring an ineligible lane is refused outright; unretiring is
 * never refused. Both append the `lane.retired` journal row the board and the story read.
 */
export function retireLane(id: string, retiring: boolean, deps: RetireLaneDeps): RetireLaneOutcome {
  if (retiring) {
    const lane = deps.lanesAll().find((row) => row.id === id);
    if (!lane) return { status: 404, body: { error: `${id} is not a registered run` } };
    if (!retireEligible(lane)) {
      return { status: 409, body: { error: `${id} is still open -- retiring only removes a finished lane from the board` } };
    }
  }
  const at = (deps.now ?? Date.now)();
  if (retiring) retireRun(retiredPath(deps.forgeHomeDir), id, at);
  else unretireRun(retiredPath(deps.forgeHomeDir), id, at);
  appendOnce(deps.journalPath, { event: 'lane.retired', run: id, actor: 'console', retired: retiring });
  return { status: 200, body: { ok: true, jid: null, message: `${retiring ? 'retired' : 'unretired'} ${id}`, undoable: retiring } };
}

/**
 * Retires a lane that cleared itself, rather than one a person archived.
 *
 * Separate from `retireLane` on purpose. `retireEligible` is the operator's rule — a
 * finished lane with no open PR — and an abandoned lane fails it by definition: it died
 * without journaling `run.finished`, so its state is still `blocked`. That is the trap
 * `retireEligible`'s own comment describes, where "the card could never leave the board".
 *
 * The caller establishes abandonment (`abandoned.ts`), which is a strictly stronger
 * condition than eligibility: no process, no queue row, nothing unpushed. So this does
 * not weaken the operator's rule, it answers a different question.
 *
 * The journal row is `lane.abandoned`, not `lane.retired`, so the board can always tell a
 * lane a person archived from one that went on its own, and the reason is on the row.
 * Retiring never deletes: `GET /lanes?archived=1` still finds it and one more row brings
 * it back.
 */
export function retireAbandonedLane(id: string, why: string, deps: RetireLaneDeps): RetireLaneOutcome {
  const at = (deps.now ?? Date.now)();
  retireRun(retiredPath(deps.forgeHomeDir), id, at);
  appendOnce(deps.journalPath, { event: 'lane.abandoned', run: id, actor: 'warden', retired: true, why });
  return {
    status: 200,
    body: { ok: true, jid: null, message: `${id} cleared itself: ${why}`, undoable: true },
  };
}
