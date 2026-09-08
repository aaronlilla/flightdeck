/**
 * The queue's own width setting: `queueWidthPath()` (`~/.forge/console/queue.json`),
 * `{ maxInFlight: N }` or absent. Mirrors `queue-pause.ts`'s split from
 * `queuePausedPath()`: read fresh on every tick and every `GET /queue`, never cached.
 * A missing or malformed file reads as the default of 4 rather than throwing -- the
 * same honest fallback `readQueuePaused` gives for its own file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { queueWidthPath } from '../paths.js';

export const DEFAULT_QUEUE_WIDTH = 4;

export function readQueueWidth(path: string = queueWidthPath()): number {
  if (!existsSync(path)) return DEFAULT_QUEUE_WIDTH;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { maxInFlight?: number };
    return typeof parsed.maxInFlight === 'number' && Number.isInteger(parsed.maxInFlight)
      ? parsed.maxInFlight
      : DEFAULT_QUEUE_WIDTH;
  } catch {
    return DEFAULT_QUEUE_WIDTH;
  }
}

export function writeQueueWidth(maxInFlight: number, path: string = queueWidthPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ maxInFlight }), 'utf8');
}
