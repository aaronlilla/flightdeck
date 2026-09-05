/**
 * Base drift and conformance drift share the blocker namespace, keyed distinctly, per
 * the 2026-09-04 decision: drift:base:<run> and drift:conformance:<run> are never the
 * same wall even for the same run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockerBoard } from '../../src/forge/blockers.js';
import { baseDriftKey, checkBaseDrift, conformanceDriftKey } from '../../src/forge/drift-blockers.js';
import { Journal } from '../../src/forge/journal.js';

let home: string;
let journal: Journal;
let parked: string[];
let resumed: string[];
let board: BlockerBoard;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-drift-blockers-'));
  journal = new Journal(join(home, 'fleet.jsonl'));
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

it('base and conformance keys never collide for the same run', () => {
  expect(baseDriftKey('r1')).not.toBe(conformanceDriftKey('r1'));
});

describe('checkBaseDrift', () => {
  it('MERGEABLE is a no-op: no park, no key raised', async () => {
    const outcome = await checkBaseDrift(board, 'r1', 'MERGEABLE');
    expect(outcome).toBe('ok');
    expect(parked).toEqual([]);
  });

  it('CONFLICTING parks the run on drift:base:<run>', async () => {
    const outcome = await checkBaseDrift(board, 'r1', 'CONFLICTING', 'develop');
    expect(outcome).toBe('blocked');
    expect(parked).toHaveLength(1);
    expect(board.runsFor(baseDriftKey('r1'))).toEqual(['r1']);
  });

  it('UNKNOWN is treated as blocked, never as fine', async () => {
    const outcome = await checkBaseDrift(board, 'r1', 'UNKNOWN');
    expect(outcome).toBe('blocked');
  });

  it('a later MERGEABLE clears a previously raised base-drift block', async () => {
    await checkBaseDrift(board, 'r1', 'CONFLICTING', 'develop');
    await checkBaseDrift(board, 'r1', 'MERGEABLE');
    expect(resumed).toHaveLength(1);
    expect(board.runsFor(baseDriftKey('r1'))).toEqual([]);
  });
});
