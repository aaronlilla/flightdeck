/**
 * One process ticks the intake queue at a time.
 *
 * Found live on 2026-09-07: a second `forge up` started while the first still held the
 * port. On this platform the second bind did not fail, both processes ran the queue
 * tick against the same log, and two items were planned twice inside a minute. The
 * per-process `advancing` set in `queue.ts` cannot see another process, so the
 * exclusion has to live on disk: a lock file holding the owner's pid, taken with an
 * exclusive create, and stolen only when that pid is provably gone.
 */
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface QueueLockInput {
  path: string;
  pid: number;
  alive: (pid: number) => boolean;
  clock?: () => number;
}

export type QueueLockOutcome =
  | { ok: true; release: () => void }
  | { ok: false; holder: number | undefined; reason: string };

function readHolder(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function writeExclusive(path: string, body: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function acquireQueueLock(input: QueueLockInput): QueueLockOutcome {
  const at = (input.clock ?? (() => Date.now()))();
  mkdirSync(dirname(input.path), { recursive: true });
  const body = JSON.stringify({ pid: input.pid, at });
  const release = (): void => {
    // Only the owner removes the file; a lock re-taken by someone else stays theirs.
    if (readHolder(input.path) === input.pid) rmSync(input.path, { force: true });
  };
  if (writeExclusive(input.path, body)) return { ok: true, release };

  const holder = readHolder(input.path);
  if (holder !== undefined && holder !== input.pid && input.alive(holder)) {
    return { ok: false, holder, reason: `another console (pid ${holder}) owns this queue` };
  }
  // Dead holder, or a file nobody can read: take it over.
  if (existsSync(input.path)) rmSync(input.path, { force: true });
  if (writeExclusive(input.path, body)) return { ok: true, release };
  const raced = readHolder(input.path);
  return { ok: false, holder: raced, reason: `another console (pid ${raced ?? 'unknown'}) took this queue first` };
}
