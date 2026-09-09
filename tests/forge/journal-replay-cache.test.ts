/**
 * `replay()` reads a journal incrementally: the second call for the same path folds only
 * the bytes appended since the first. The failure this closes: a 20 MB journal replayed in
 * full on every request path that wanted live runs or today's tokens, 16.8 s per call on
 * the 4120 server's own thread, on 2026-09-09.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forgetReplay, replay, replayFresh } from '../../src/forge/journal.js';

let dir: string;
let path: string;

function row(run: string, event: string, at: number): string {
  return `${JSON.stringify({ id: `${run}-${at}`, at, run, actor: 'runner', event })}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'replay-cache-'));
  path = join(dir, 'fleet.jsonl');
  forgetReplay(path);
});

afterEach(() => {
  forgetReplay(path);
  rmSync(dir, { recursive: true, force: true });
});

describe('replay() reads a growing journal incrementally', () => {
  it('sees a row appended after the first read, without re-parsing what it already folded', () => {
    writeFileSync(path, row('a', 'run.started', 1), 'utf8');
    const first = replay(path);
    expect(first.events).toHaveLength(1);

    appendFileSync(path, row('b', 'run.started', 2), 'utf8');
    const second = replay(path);
    expect(second.events.map((event) => event.run)).toEqual(['a', 'b']);
    // The same folded state is handed back, grown in place: the proof that the first
    // read was not thrown away and the file was not parsed twice.
    expect(second).toBe(first);
  });

  it('matches a full parse of the same file', () => {
    writeFileSync(path, row('a', 'run.started', 1) + row('a', 'turn.end', 2), 'utf8');
    replay(path);
    appendFileSync(path, row('a', 'run.done', 3), 'utf8');
    expect(replay(path).events).toEqual(replayFresh(path).events);
  });

  it('starts over when the file shrinks, rather than resuming into different bytes', () => {
    writeFileSync(path, row('a', 'run.started', 1) + row('b', 'run.started', 2), 'utf8');
    expect(replay(path).events).toHaveLength(2);
    writeFileSync(path, row('c', 'run.started', 3), 'utf8');
    expect(replay(path).events.map((event) => event.run)).toEqual(['c']);
  });

  it('answers an absent file with an empty state and picks the file up once it appears', () => {
    expect(replay(path).events).toEqual([]);
    writeFileSync(path, row('a', 'run.started', 1), 'utf8');
    expect(replay(path).events).toHaveLength(1);
  });
});
