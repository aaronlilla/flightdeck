/**
 * The park record a Warden actuator writes from a different process than the one
 * holding the run's live session.
 *
 * `sdkengine.ts`'s own `parked` map (B.3.1) only ever lives inside the `forge run`
 * process that owns the session: it stops a run from taking another tool call after
 * `AskUserQuestion` or `forge_ask`, but nothing outside that process can set it. Warden
 * runs inside `forge up`, a different process, so a park it orders has nowhere to land
 * unless something on disk crosses that boundary the same way the inbox and the run's
 * own inbox already do.
 *
 * One JSON file per run, read fresh on every `PreToolUse` call (`buildPreToolUseHook`
 * checks it ahead of the in-process ask park), so the deny is real on the very next tool
 * call the run attempts after Warden writes the file -- not merely a journal row saying
 * a park happened.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDir } from './paths.js';

export interface ParkRecord {
  /** Who ordered the park and why, for the deny message and the journal row. */
  key: string;
  reason: string;
  at: number;
}

function pathFor(run: string): string {
  return join(runDir(run), 'park.json');
}

export function writeParkRecord(run: string, record: ParkRecord): void {
  mkdirSync(runDir(run), { recursive: true });
  writeFileSync(pathFor(run), JSON.stringify(record, null, 2), 'utf8');
}

/** Read fresh from disk every call: this is the whole point of a cross-process record. */
export function readParkRecord(run: string): ParkRecord | undefined {
  const path = pathFor(run);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ParkRecord;
  } catch {
    // A half-written record is not a park. Treating it as one would deny a run on
    // nothing a person or a Warden actually ordered.
    return undefined;
  }
}

export function clearParkRecord(run: string): void {
  const path = pathFor(run);
  if (existsSync(path)) rmSync(path);
}
