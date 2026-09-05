/**
 * A blocker key shared by more than one run: one event, one park each, ordered resume.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockerBoard } from '../../src/forge/blockers.js';
import { replayEvents } from '../../src/forge/contracts.js';
import { Journal } from '../../src/forge/journal.js';

let home: string;
let journalPath: string;
let journal: Journal;
let parked: string[];
let resumed: string[];
let board: BlockerBoard;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-blockers-'));
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
  parked = [];
  resumed = [];
  board = new BlockerBoard({
    journal,
    actuator: {
      park: async (run, reason) => { parked.push(`${run}:${reason}`); return true; },
      resume: async (run, input) => { resumed.push(`${run}:${input}`); },
    },
  });
});

afterEach(() => {
  journal.close();
  rmSync(home, { recursive: true, force: true });
});

describe('three runs sharing a lock', () => {
  it('all park, but only one blocker.raised event fires', async () => {
    await board.raise('lock:main-checkout-bb', 'held by session s1', 'r1');
    await board.raise('lock:main-checkout-bb', 'held by session s1', 'r2');
    await board.raise('lock:main-checkout-bb', 'held by session s1', 'r3');

    expect(parked).toEqual([
      'r1:blocked on lock:main-checkout-bb: held by session s1',
      'r2:blocked on lock:main-checkout-bb: held by session s1',
      'r3:blocked on lock:main-checkout-bb: held by session s1',
    ]);

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    const raised = events.filter((event) => event.event === 'blocker.raised');
    expect(raised).toHaveLength(1);
    expect(board.runsFor('lock:main-checkout-bb')).toEqual(['r1', 'r2', 'r3']);
  });

  it('clearing the key resumes all three in the order they arrived', async () => {
    await board.raise('lock:main-checkout-bb', 'held', 'r3');
    await board.raise('lock:main-checkout-bb', 'held', 'r1');
    await board.raise('lock:main-checkout-bb', 'held', 'r2');

    const resumedRuns = await board.clear('lock:main-checkout-bb');

    expect(resumedRuns).toEqual(['r3', 'r1', 'r2']);
    expect(resumed.map((line) => line.split(':')[0])).toEqual(['r3', 'r1', 'r2']);

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    expect(events.filter((event) => event.event === 'blocker.cleared')).toHaveLength(1);
  });

  it('a fresh raise after clearing starts a clean list and raises a new event', async () => {
    await board.raise('k', 'first', 'r1');
    await board.clear('k');
    await board.raise('k', 'second', 'r2');

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    expect(events.filter((event) => event.event === 'blocker.raised')).toHaveLength(2);
    expect(board.runsFor('k')).toEqual(['r2']);
  });
});
