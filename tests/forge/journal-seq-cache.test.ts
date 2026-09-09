/**
 * Stamping a seq on an appended row must not cost a read of the whole journal.
 *
 * The failure this closes: `appendOnce` scanned the entire file for the highest seq on
 * every call, and `Journal` did the same on its first append. At 20 MB that was 10 s
 * and more per row, on the 4120 server's own thread, several times a minute, on
 * 2026-09-09. The seq now comes from a per-path memory of the last size and seq
 * known, and only the bytes appended since are read.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendOnce, Journal } from '../../src/forge/journal.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seq-cache-'));
  path = join(dir, 'fleet.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A row the size of a real one: tool.start rows carry a few hundred bytes of args. */
const PAYLOAD = 'x'.repeat(300);

function line(seq: number): string {
  return `${JSON.stringify({ id: `row-${seq}`, seq, at: seq, version: 1, event: 'tool.start', actor: 'worker', args: PAYLOAD })}\n`;
}

describe('the seq an append stamps', () => {
  it('continues past a row another process appended since the last look', () => {
    appendOnce(path, { event: 'run.started', run: 'a' });
    // Out of band: a worker in another process wrote seq 50 to the same file.
    appendFileSync(path, line(50), 'utf8');
    const next = appendOnce(path, { event: 'turn.end', run: 'a' });
    expect(next.seq).toBe(51);
  });

  it('starts over from what is on disk when the file shrank', () => {
    appendOnce(path, { event: 'run.started', run: 'a' });
    appendOnce(path, { event: 'turn.end', run: 'a' });
    writeFileSync(path, line(3), 'utf8');
    expect(appendOnce(path, { event: 'note' }).seq).toBe(4);
  });

  it('is shared between appendOnce and a Journal on the same file', () => {
    const journal = new Journal(path);
    try {
      expect(journal.append({ event: 'run.started', run: 'a' }).seq).toBe(1);
      expect(appendOnce(path, { event: 'turn.end', run: 'a' }).seq).toBe(2);
      // A fresh instance sees both rows without a full scan of its own.
      const again = new Journal(path);
      try {
        expect(again.append({ event: 'run.done', run: 'a' }).seq).toBe(3);
      } finally {
        again.close();
      }
    } finally {
      journal.close();
    }
  });

  it('does not read a large journal back to stamp the next row', () => {
    // 200,000 rows: a full scan is seconds; a tail read is not.
    const rows: string[] = [];
    for (let seq = 1; seq <= 200_000; seq += 1) rows.push(line(seq));
    writeFileSync(path, rows.join(''), 'utf8');
    appendOnce(path, { event: 'note' });
    const t0 = performance.now();
    const row = appendOnce(path, { event: 'note' });
    const ms = performance.now() - t0;
    expect(row.seq).toBe(200_002);
    expect(ms).toBeLessThan(250);
  });

  it('appending onto a torn last line reads one byte to know, and still starts a new line', () => {
    writeFileSync(path, `${line(1)}{"event":"turn.end","run":"al`, 'utf8');
    const journal = new Journal(path);
    try {
      const row = journal.append({ event: 'note' });
      expect(row.seq).toBe(2);
    } finally {
      journal.close();
    }
    const text = readFileSync(path, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(3);
  });
});
