/**
 * The queue's own pause flag: `~/.forge/console/queue-paused.json` (`queuePausedPath()`),
 * `{ paused: true }` or absent. Separate from `killSwitchPath()` -- the kill switch stops
 * every launch fleet-wide; this stops only the intake queue's worker from starting
 * anything new. Both are checked fresh on every tick (`runQueueTick`), never cached.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { queuePausedPath } from '../paths.js';

export function readQueuePaused(path: string = queuePausedPath()): boolean {
  if (!existsSync(path)) return false;
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { paused?: boolean }).paused === true;
  } catch {
    return false;
  }
}

export function writeQueuePaused(paused: boolean, path: string = queuePausedPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ paused }), 'utf8');
}
