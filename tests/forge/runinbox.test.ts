/**
 * Plan item 3, 2026-09-23: `deliverAnswer`'s relaunch hand-off, for a run parked on an
 * open ask. `RunInbox` itself already has coverage through `sdkengine`/`cli` specimens;
 * this covers only the new `relaunch` parameter added here.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { deliverAnswer } from '../../src/forge/runinbox.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-runinbox-'));
  process.env['FORGE_HOME'] = dir;
});

describe('Plan item 3: deliverAnswer relaunches a run parked on an open ask', () => {
  it('relaunches every inbox target no live engine already answered', async () => {
    const relaunched: string[] = [];
    const { delivered } = await deliverAnswer(
      { runs: ['goal-a'], goals: [], question: 'which repo?' },
      'ask-1', 'the frontend one', undefined,
      async (goal) => { relaunched.push(goal); return 'relaunched'; },
    );

    expect(delivered).toEqual([]);
    expect(relaunched).toEqual(['goal-a']);
  });

  it('does not relaunch a target the live engine already delivered to in place', async () => {
    const relaunched: string[] = [];
    const engine = { answer: async () => ({ delivered: true }) };
    const { delivered } = await deliverAnswer(
      { runs: ['goal-a'], goals: [], question: 'which repo?' },
      'ask-1', 'the frontend one', engine,
      async (goal) => { relaunched.push(goal); return 'relaunched'; },
    );

    expect(delivered).toEqual(['goal-a']);
    expect(relaunched).toEqual([]);
  });

  it('with no relaunch supplied, behaves exactly as before: inbox-only delivery', async () => {
    const { delivered } = await deliverAnswer(
      { runs: ['goal-a'], goals: [], question: 'which repo?' },
      'ask-1', 'the frontend one',
    );
    expect(delivered).toEqual([]);
  });

  it('targets goals over runs, same as the inbox write above it, when an ask recorded goals', async () => {
    const relaunched: string[] = [];
    await deliverAnswer(
      { runs: ['segment-2'], goals: ['goal-a'], question: 'which repo?' },
      'ask-1', 'the frontend one', undefined,
      async (goal) => { relaunched.push(goal); return 'skipped'; },
    );
    expect(relaunched).toEqual(['goal-a']);
  });
});
