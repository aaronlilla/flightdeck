/**
 * The journal is memory: append-only JSONL, one line per event, fsynced.
 *
 * State is `replay(journal)`. Nothing else is authoritative, so the row that decides
 * whether this design survives a crash is the torn last line: a process killed mid-write
 * leaves half a line, and a replay that throws on it loses every event before it too.
 *
 * The `cause` field is the other load-bearing one. Every event names the event it answers,
 * and that chain is the provenance graph the ticket sheet reads.
 */
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Journal, JournalCache, appendOnce, replay, type ForgeEvent, type RangeReader } from '../../src/forge/journal.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-journal-'));
  path = join(dir, 'fleet.jsonl');
});

function write(...rows: Partial<ForgeEvent>[]): void {
  const journal = new Journal(path);
  for (const row of rows) journal.append(row as ForgeEvent);
  journal.close();
}

describe('appending', () => {
  it('writes one line per event and stamps an id and a time', () => {
    const journal = new Journal(path);
    const first = journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    const second = journal.append({ event: 'turn.end', run: 'alpha', actor: 'worker' });
    journal.close();

    expect(first.id).toBeTruthy();
    expect(second.id).not.toBe(first.id);
    expect(first.at).toBeGreaterThan(0);
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });

  it('keeps the cause chain an event was given', () => {
    const journal = new Journal(path);
    const asked = journal.append({ event: 'ask.raised', run: 'alpha', actor: 'worker' });
    const answered = journal.append({
      event: 'ask.answered', run: 'alpha', actor: 'console', cause: asked.id,
    });
    journal.close();
    expect(replay(path).events[1]?.cause).toBe(answered.cause);
    expect(answered.cause).toBe(asked.id);
  });

  it('never rewrites a line it has already written', () => {
    const journal = new Journal(path);
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    const before = readFileSync(path, 'utf8');
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner' });
    journal.close();
    expect(readFileSync(path, 'utf8').startsWith(before)).toBe(true);
  });

  it('stamps a monotonic seq and a schema version on every row', () => {
    const journal = new Journal(path);
    const first = journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    const second = journal.append({ event: 'turn.end', run: 'alpha', actor: 'worker' });
    journal.close();

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
  });

  it('keeps seq monotonic across a fresh Journal instance opened on an existing file', () => {
    let journal = new Journal(path);
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();

    journal = new Journal(path);
    const third = journal.append({ event: 'turn.end', run: 'alpha', actor: 'worker' });
    journal.close();

    expect(third.seq).toBe(2);
  });

  it('a caller cannot override the seq or version Journal stamps', () => {
    const journal = new Journal(path);
    const row = journal.append({
      event: 'run.started', run: 'alpha', actor: 'runner', seq: 999, version: 999,
    } as ForgeEvent);
    journal.close();
    expect(row.seq).toBe(1);
    expect(row.version).toBe(1);
  });

  it('appendOnce stamps seq and version too, continuing from what is already on disk', () => {
    const first = appendOnce(path, { event: 'gotcha', actor: 'runner' });
    const second = appendOnce(path, { event: 'gotcha', actor: 'runner' });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.version).toBe(1);
  });
});

describe('replay', () => {
  it('rebuilds a run from its events', () => {
    write(
      { event: 'run.started', run: 'alpha', actor: 'runner', ticket: 'BBZ-1' },
      { event: 'turn.end', run: 'alpha', actor: 'worker', context: 12_000 },
      { event: 'turn.end', run: 'alpha', actor: 'worker', context: 40_000 },
      { event: 'run.finished', run: 'alpha', actor: 'runner', verdict: 'done' },
    );
    const state = replay(path);
    const run = state.runs['alpha'];
    expect(run?.state).toBe('finished');
    expect(run?.verdict).toBe('done');
    expect(run?.ticket).toBe('BBZ-1');
    expect(run?.turns).toBe(2);
    expect(run?.context).toBe(40_000);
  });

  it('carries the run\'s model-policy class forward, for liveness\'s context ceiling', () => {
    write({ event: 'run.started', run: 'alpha', actor: 'runner', className: 'master' });
    expect(replay(path).runs['alpha']?.className).toBe('master');
  });

  it('leaves className unset when a run never journaled one', () => {
    write({ event: 'run.started', run: 'alpha', actor: 'runner' });
    expect(replay(path).runs['alpha']?.className).toBeUndefined();
  });

  it('carries usage forward into a burn total per tier', () => {
    write(
      { event: 'run.started', run: 'alpha', actor: 'runner' },
      {
        event: 'usage', run: 'alpha', actor: 'worker', model: 'claude-sonnet-5',
        usage: { input: 100, cacheRead: 90_000, cacheCreation: 1_000, output: 500 },
      },
      {
        event: 'usage', run: 'alpha', actor: 'worker', model: 'claude-opus-5',
        usage: { input: 100, cacheRead: 90_000, cacheCreation: 1_000, output: 500 },
      },
    );
    const state = replay(path);
    expect(state.burn['sonnet']).toBeGreaterThan(0);
    expect(state.burn['opus']).toBeGreaterThan(state.burn['sonnet'] ?? 0);
    expect(state.runs['alpha']?.costUsd).toBeCloseTo(
      (state.burn['sonnet'] ?? 0) + (state.burn['opus'] ?? 0), 8,
    );
  });

  it('B.3.9: an unknown model id bills nothing and is named rather than priced as Opus', () => {
    write(
      { event: 'run.started', run: 'alpha', actor: 'runner' },
      {
        event: 'usage', run: 'alpha', actor: 'worker', model: 'claude-mystery-9',
        usage: { input: 100, cacheRead: 90_000, cacheCreation: 1_000, output: 500 },
      },
    );
    const state = replay(path);
    // The falsifier this closes: a fallback that still bills Opus rates would put a
    // nonzero amount somewhere in burn for this usage row.
    expect(Object.values(state.burn).every((amount) => amount === 0)).toBe(true);
    expect(state.runs['alpha']?.costUsd).toBe(0);
    expect(state.unknownModels).toContain('claude-mystery-9');
  });

  it('records a handoff and the successor it names', () => {
    write(
      { event: 'run.started', run: 'alpha', actor: 'runner' },
      { event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2' },
      { event: 'run.started', run: 'alpha-2', actor: 'runner', predecessor: 'alpha' },
    );
    const state = replay(path);
    expect(state.runs['alpha']?.state).toBe('handed-off');
    expect(state.runs['alpha']?.successor).toBe('alpha-2');
    expect(state.runs['alpha-2']?.predecessor).toBe('alpha');
    expect(state.handoffs).toBe(1);
  });

  it('reads a journal that does not exist as an empty state', () => {
    const state = replay(join(dir, 'nothing-here.jsonl'));
    expect(state.events).toEqual([]);
    expect(state.torn).toBe(0);
  });
});

describe('a journal torn by a crash', () => {
  it('keeps every whole line before the torn one and counts the loss', () => {
    write(
      { event: 'run.started', run: 'alpha', actor: 'runner' },
      { event: 'turn.end', run: 'alpha', actor: 'worker', context: 5_000 },
    );
    // A process killed mid-write leaves a prefix of a line and no newline.
    writeFileSync(path, readFileSync(path, 'utf8') + '{"event":"turn.end","run":"al',
      { encoding: 'utf8' });

    const state = replay(path);
    expect(state.events).toHaveLength(2);
    expect(state.torn).toBe(1);
    expect(state.runs['alpha']?.turns).toBe(1);
  });

  it('survives a torn line in the middle, not only at the end', () => {
    write({ event: 'run.started', run: 'alpha', actor: 'runner' });
    const good = readFileSync(path, 'utf8');
    writeFileSync(path, good + '{"event":"broken\n'
      + JSON.stringify({ event: 'run.finished', run: 'alpha', actor: 'runner', at: 2, id: 'z' })
      + '\n', { encoding: 'utf8' });

    const state = replay(path);
    expect(state.torn).toBe(1);
    expect(state.runs['alpha']?.state).toBe('finished');
  });

  it('appends cleanly onto a torn journal instead of corrupting the next line', () => {
    write({ event: 'run.started', run: 'alpha', actor: 'runner' });
    writeFileSync(path, readFileSync(path, 'utf8') + '{"event":"turn.e',
      { encoding: 'utf8' });

    const journal = new Journal(path);
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner' } as ForgeEvent);
    journal.close();

    const state = replay(path);
    expect(state.torn).toBe(1);
    expect(state.runs['alpha']?.state).toBe('finished');
  });
});

describe('B.3.9: JournalCache reads only the appended bytes', () => {
  it('a second read after one appended row only touches the bytes written since the first', () => {
    // Many rows already on disk before the first read, so a second read that re-parsed
    // the whole file (the falsifier) would read close to the full file size again,
    // rather than the one small row appended since.
    for (let index = 0; index < 50; index += 1) {
      write({ event: 'turn.end', run: 'alpha', actor: 'worker', context: index });
    }

    let bytesRead = 0;
    const countingReader: RangeReader = {
      size: (path2) => statSync(path2).size,
      readRange: (path2, start, end) => {
        bytesRead += end - start;
        const fd = openSync(path2, 'r');
        const buffer = Buffer.alloc(end - start);
        readSync(fd, buffer, 0, end - start, start);
        closeSync(fd);
        return buffer.toString('utf8');
      },
    };
    const cache = new JournalCache(countingReader);

    const first = cache.read(path);
    expect(first.runs['alpha']?.turns).toBe(50);
    const bytesAfterFirst = bytesRead;
    expect(bytesAfterFirst).toBeGreaterThan(0);

    write({ event: 'run.finished', run: 'alpha', actor: 'runner' });
    const second = cache.read(path);
    expect(second.runs['alpha']?.state).toBe('finished');

    // The falsifier this closes: re-parsing the whole file on the second read would make
    // the second read's byte count close to the first read's total (50 rows), not the
    // one small row actually appended since.
    const bytesOnSecondRead = bytesRead - bytesAfterFirst;
    expect(bytesOnSecondRead).toBeGreaterThan(0);
    expect(bytesOnSecondRead).toBeLessThan(bytesAfterFirst / 10);
  });

  it('folds the same state as a full replay would, read incrementally in three steps', () => {
    const cache = new JournalCache();
    write({ event: 'run.started', run: 'alpha', actor: 'runner' });
    cache.read(path);
    write({
      event: 'usage', run: 'alpha', actor: 'worker', model: 'claude-sonnet-5',
      usage: { input: 100, cacheRead: 1_000, cacheCreation: 0, output: 10 },
    });
    cache.read(path);
    write({ event: 'run.finished', run: 'alpha', actor: 'runner' });
    const incremental = cache.read(path);
    const full = replay(path);

    expect(incremental.runs['alpha']).toEqual(full.runs['alpha']);
    expect(incremental.burn).toEqual(full.burn);
  });
});
