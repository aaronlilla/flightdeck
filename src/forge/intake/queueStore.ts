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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';

function readRange(path: string, start: number, end: number): string {
  if (end <= start) return '';
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    readSync(fd, buffer, 0, end - start, start);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
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

  /** The fold so far: every id in first-seen order, its latest fields, and the ids
   *  removed. Grown from the bytes appended since the last read, never rebuilt from the
   *  whole file unless the file shrank. `all()` on a 2 MB log used to re-read and
   *  re-parse the file every call, and `reads.ts` calls it once per lane per request:
   *  61% of the 4120 server's CPU was that read on 2026-09-09. */
  private readonly order: string[] = [];

  private readonly byId = new Map<string, QueueItem>();

  private readonly removed = new Set<string>();

  private offset = 0;

  private carry = '';

  private bytes = 0;

  /** Bytes this store has read from its log so far. A test's proof that a repeat
   *  `all()` costs nothing and an append costs only its own row. */
  get bytesRead(): number {
    return this.bytes;
  }

  private catchUp(): void {
    if (!existsSync(this.path)) {
      this.reset();
      return;
    }
    const size = statSync(this.path).size;
    if (size < this.offset) this.reset();
    if (size === this.offset) return;
    const chunk = this.carry + readRange(this.path, this.offset, size);
    this.bytes += size - this.offset;
    this.offset = size;
    const lines = chunk.split('\n');
    this.carry = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      this.fold(JSON.parse(line) as QueueRow);
    }
  }

  private reset(): void {
    this.order.length = 0;
    this.byId.clear();
    this.removed.clear();
    this.rowsById.clear();
    this.offset = 0;
    this.carry = '';
  }

  private fold(row: QueueRow): void {
    const log = this.rowsById.get(row.id);
    if (log) log.push(row);
    else this.rowsById.set(row.id, [row]);
    if (!this.byId.has(row.id)) this.order.push(row.id);
    const prior = this.byId.get(row.id) ?? defaultItem(row.id, row.at);
    // `at`/`removedAt` are this store's own bookkeeping, never part of the `QueueItem`
    // shape the board reads -- stripped here so the fold's output matches that type
    // exactly rather than leaking the row's own write-time fields onto it.
    const { at: _at, removedAt, ...fields } = row;
    if (removedAt) this.removed.add(row.id);
    else this.removed.delete(row.id);
    this.byId.set(row.id, { ...prior, ...fields });
  }

  /** Appends one row. The caller owns building the merged `QueueItem` this row moves
   *  the fold to -- this method only ever writes what it is given. */
  append(row: QueueRow): void {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, 'utf8');
  }

  /** Every item this log has ever seen, folded to its latest fields, in the order each
   *  id first appeared. An item removed (`removedAt` set on its latest row) is excluded
   *  -- the row itself stays on disk for anyone reading the raw log, but the board's own
   *  list never shows it again. The items are the store's own objects: read them, never
   *  mutate them. */
  all(): QueueItem[] {
    this.catchUp();
    return this.order.map((id) => this.byId.get(id)!).filter((item) => !this.removed.has(item.id));
  }

  get(id: string): QueueItem | undefined {
    return this.all().find((item) => item.id === id);
  }

  /** Every row ever appended for `id`, in order: the item's own transition log, for a
   *  reader that needs to count how often something happened rather than the fold. */
  history(id: string): QueueRow[] {
    this.catchUp();
    return [...(this.rowsById.get(id) ?? [])];
  }

  /** Every row per id, in append order, for `history()`. Grown by the same fold. */
  private readonly rowsById = new Map<string, QueueRow[]>();
}
