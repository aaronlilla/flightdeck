/**
 * `~/.forge/self/findings.jsonl`: one row per `SelfFinding`, the same append-only,
 * fold-to-latest shape `queueStore.ts` already keeps for the intake queue's own log.
 *
 * A finding's `id` is a stable hash of its kind and signature (`analyze.ts`), so the
 * same underlying fact recorded twice folds to one row rather than growing the ledger
 * every time `analyze()` runs over the same evidence -- `enqueue.ts` depends on this to
 * stay idempotent without keeping its own separate "have I seen this" set.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SelfFinding } from './analyze.js';

export interface FindingRow extends SelfFinding {
  at: number;
  /** Set once `enqueue.ts` turns this finding into a queue item. Absent means the
   *  finding is recorded but has not yet been (or will never be, past the in-flight
   *  ceiling) turned into work. */
  enqueuedItemId?: string;
  /** R-02 guard #4: set once `enqueue.ts` has appended this finding to
   *  `doctrine/ROADMAP.md`'s `## Proposed` section because it cited no `R-nn` id.
   *  Absent means it was never proposed -- present stops the same finding from being
   *  appended again on every tick. */
  proposedAt?: number;
}

type FindingRawRow = Partial<FindingRow> & { id: string; at: number };

export class FindingsLedger {
  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  private rows(): FindingRawRow[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as FindingRawRow);
  }

  /** Every finding this ledger has ever seen, folded to its latest fields, in the order
   *  each id first appeared. */
  all(): FindingRow[] {
    const order: string[] = [];
    const byId = new Map<string, FindingRow>();
    for (const row of this.rows()) {
      if (!byId.has(row.id)) order.push(row.id);
      const prior = byId.get(row.id);
      byId.set(row.id, { ...(prior as FindingRow | undefined), ...row } as FindingRow);
    }
    return order.map((id) => byId.get(id)!);
  }

  get(id: string): FindingRow | undefined {
    return this.all().find((row) => row.id === id);
  }

  /**
   * Record a finding. Idempotent by id: a finding already on the ledger writes nothing
   * new and the caller gets back the row already there, never a duplicate line.
   */
  record(finding: SelfFinding, now: number): FindingRow {
    const existing = this.get(finding.id);
    if (existing) return existing;
    const row: FindingRow = { ...finding, at: now };
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  }

  /** Marks a recorded finding as turned into queue item `itemId`. A no-op, not a
   *  throw, for an id this ledger never recorded -- `enqueue.ts` never calls this for
   *  one it did not itself just `record()`, but a caller mistake here should read as
   *  "nothing changed", not crash the tick. */
  markEnqueued(id: string, itemId: string, now: number): void {
    if (!this.get(id)) return;
    appendFileSync(this.path, `${JSON.stringify({ id, at: now, enqueuedItemId: itemId })}\n`, 'utf8');
  }

  /** R-02 guard #4: marks a recorded finding as already appended to `## Proposed`.
   *  Same no-op-on-unknown-id discipline as `markEnqueued`. */
  markProposed(id: string, now: number): void {
    if (!this.get(id)) return;
    appendFileSync(this.path, `${JSON.stringify({ id, at: now, proposedAt: now })}\n`, 'utf8');
  }
}
