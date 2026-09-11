/**
 * What one item's interview already settled, kept across ticks.
 *
 * An item that raises a question holds at `planning` for as long as the answer takes,
 * and the tick that finally writes its brief is a different call in a different process
 * from the one that ran the interview. Without this, everything the scout found would be
 * re-derived on that tick -- a second `git grep` and a second reasoner call whose answer
 * can differ from the first, so the brief would cite evidence the interview never saw.
 *
 * One JSON file per item, in the same spirit as `inbox.ts`: readable, hand-editable, and
 * absent means "not interviewed yet" rather than an error.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { InterviewAnswer } from './interview.ts';

export interface InterviewRecord {
  itemId: string;
  ticket: string;
  at: number;
  /** Everything answered without a person: the scout's findings, verbatim. */
  answers: InterviewAnswer[];
  /** Set while the interview's own reasoner call is in flight, cleared when it lands. A
   *  planning hop that re-enters the item inside `INTERVIEW_LEASE_MS` returns `waiting`
   *  without a call: on 2026-09-11 every pulled ticket was interviewed four times. */
  inFlightAt?: number;
}

export class InterviewStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(itemId: string): string {
    return join(this.dir, `${itemId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  get(itemId: string): InterviewRecord | undefined {
    const path = this.pathFor(itemId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as InterviewRecord;
    } catch {
      return undefined;
    }
  }

  put(record: InterviewRecord): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(record.itemId), JSON.stringify(record, null, 2), 'utf8');
  }

  /** Dropped once the brief is written: the record's whole purpose is to survive the
   *  wait, and a stale one would answer a re-queued item's interview for it. */
  clear(itemId: string): void {
    rmSync(this.pathFor(itemId), { force: true });
  }
}

/** An in-memory store for a specimen that has no reason to touch disk. */
export class MemoryInterviewStore {
  private readonly rows = new Map<string, InterviewRecord>();

  get(itemId: string): InterviewRecord | undefined { return this.rows.get(itemId); }
  put(record: InterviewRecord): void { this.rows.set(record.itemId, record); }
  clear(itemId: string): void { this.rows.delete(itemId); }
}

export type InterviewRecords = Pick<InterviewStore, 'get' | 'put' | 'clear'>;
