/**
 * `retire.ts` (H1.7): which lanes may leave the board's default view, and the
 * append-only log (`~/.forge/console/retired.jsonl`) that remembers which ones have.
 * Retiring never deletes anything -- `GET /lanes?archived=1` still finds a retired lane,
 * and unretiring is one more row, never an edit to the one that came before it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Lane } from '../../shared/console-model.js';

export function retiredPath(forgeHomeDir: string): string {
  return join(forgeHomeDir, 'console', 'retired.jsonl');
}

const FINISHED_PROBE_STATES = new Set<Lane['state']>(['done', 'unverified', 'exhausted']);

/** Whether a lane is a candidate for `POST /run/:id/retire` or `POST /retire-finished`:
 *  done, merged or killed outright (a finished probe counts even on `exhausted` or
 *  `unverified`, states a probe alone reaches by design), with no unmerged PR still
 *  open on it and no live process behind it. A lane failing any of these stays on the
 *  board -- retiring is never a way to make an unresolved lane disappear. */
export function retireEligible(lane: Lane): boolean {
  const finishedProbe = lane.kind === 'probe' && FINISHED_PROBE_STATES.has(lane.state);
  const finished = lane.state === 'done' || lane.state === 'merged' || lane.state === 'killed' || finishedProbe;
  if (!finished) return false;
  if (lane.pr && !lane.pr.merged) return false;
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
