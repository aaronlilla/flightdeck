/**
 * The intake queue's own log: `~/.forge/console/queue.jsonl` (`queuePath()`), one row per
 * item transition, append-only like every other Forge log. `all()`/`get()` fold it to the
 * current item list the same way `ActionsLedger.get()` folds its own rows to "the latest
 * word on this jid" -- a later row for an id overwrites only the fields it names, so a
 * transition never has to repeat fields it did not change.
 *
 * This file never writes the fleet journal itself. `queue.ts`'s `advanceItem` writes both:
 * a row here for the board's own list, and a `queue.*` row on the fleet journal for the
 * audit trail every other Forge write already shares.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { QueueItem } from '../../shared/console-model.js';

/** One row this store ever appends: an id plus whichever fields changed. `at` is the
 *  wall-clock time of the write, kept distinct from `QueueItem.updatedAt` (which a
 *  caller sets explicitly, from its own clock, so a specimen can pin it). `removedAt`
 *  is store-only -- never part of the public `QueueItem` the board reads -- and is what
 *  `remove()` sets to take an item out of `all()` without erasing its history. */
export type QueueRow = Partial<QueueItem> & { id: string; at: number; removedAt?: number };

function defaultItem(id: string, at: number): QueueItem {
  return {
    id, source: 'brief', input: '', ticket: null, repo: null, briefPath: null,
    branch: null, worktreePath: null, base: null,
    state: 'queued', reason: null, runKey: null, pr: null, journalIds: [],
    createdAt: at, updatedAt: at,
  };
}

export class QueueStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  private rows(): QueueRow[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as QueueRow);
  }

  /** Appends one row. The caller owns building the merged `QueueItem` this row moves
   *  the fold to -- this method only ever writes what it is given. */
  append(row: QueueRow): void {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, 'utf8');
  }

  /** Every item this log has ever seen, folded to its latest fields, in the order each
   *  id first appeared. An item removed (`removedAt` set on its latest row) is excluded
   *  -- the row itself stays on disk for anyone reading the raw log, but the board's own
   *  list never shows it again. */
  all(): QueueItem[] {
    const order: string[] = [];
    const byId = new Map<string, QueueItem>();
    const removed = new Set<string>();
    for (const row of this.rows()) {
      if (!byId.has(row.id)) order.push(row.id);
      const prior = byId.get(row.id) ?? defaultItem(row.id, row.at);
      // `at`/`removedAt` are this store's own bookkeeping, never part of the `QueueItem`
      // shape the board reads -- stripped here so the fold's output matches that type
      // exactly rather than leaking the row's own write-time fields onto it.
      const { at: _at, removedAt, ...fields } = row;
      if (removedAt) removed.add(row.id);
      byId.set(row.id, { ...prior, ...fields });
    }
    return order.map((id) => byId.get(id)!).filter((item) => !removed.has(item.id));
  }

  get(id: string): QueueItem | undefined {
    return this.all().find((item) => item.id === id);
  }
}
