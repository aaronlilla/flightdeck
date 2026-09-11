/**
 * The on-disk half of `forge intake --once`'s watermark: one small JSON file per source
 * under `~/.forge/intake/`, so a second poll -- from the CLI or from the chain's own
 * timer -- does not re-observe everything the first one already saw. Pulled out of
 * `cli.ts` so `chain-wire.ts` reads and writes the exact same files rather than keeping
 * a second, divergent copy of this logic.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PollSourceName, Watermark } from '../contracts.js';
import { forgeHome } from '../paths.js';
import { initialWatermark } from './watermark.js';
import type { WatermarkStore } from './once.js';

export function watermarkPath(source: string): string {
  return join(forgeHome(), 'intake', `${source}.watermark.json`);
}

export function readWatermark(source: PollSourceName): Watermark {
  try {
    return JSON.parse(readFileSync(watermarkPath(source), 'utf8'));
  } catch {
    return initialWatermark(source);
  }
}

export function writeWatermark(source: string, mark: Watermark): void {
  const dir = join(forgeHome(), 'intake');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(watermarkPath(source), JSON.stringify(mark), 'utf8');
}

export function fileWatermarkStore(): WatermarkStore {
  return { get: readWatermark, set: writeWatermark };
}

/** R-68: deletes every `*.watermark.json` in `dir` -- and nothing else in it -- so a
 *  full re-sync re-observes every source from scratch. Returns the basenames it deleted,
 *  never throws on a missing directory (there is nothing to reset). */
export function resetWatermarks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const deleted: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.watermark.json')) continue;
    rmSync(join(dir, name));
    deleted.push(name);
  }
  return deleted;
}
