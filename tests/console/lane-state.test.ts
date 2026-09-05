import { describe, expect, it } from 'vitest';

import { categoryOf } from '../../src/console/laneState.js';
import { laneBlocked } from '../../src/console/fixtures/state.js';
import type { LaneRecord } from '../../src/console/types.js';

/**
 * Item 2 of the 2026-09-05 loose-ends goal: a finished chain's lane -- one whose worker
 * already returned `exhausted`, `done` or `parked` and is no longer live -- must never
 * count as `running`. Before this fix, `categoryOf` fell through to a bare `return
 * 'running'` whenever `run_state` was absent, `needs_aaron` was unset and `column` was
 * the real value every lane actually carries (`'forge'`, never `'blocked'`/`'done'`), so
 * every finished chain in the fleet counted as running until something else overwrote it.
 */
function finishedLane(verdict: string): LaneRecord {
  return {
    ...laneBlocked,
    column: 'forge',
    verdict,
    needs_aaron: null,
    run_state: undefined,
  };
}

describe('categoryOf: a finished chain is never counted as running', () => {
  it('counts one live run_state and three finished verdicts as one running lane', () => {
    const liveLane: LaneRecord = { ...laneBlocked, column: 'forge', run_state: 'started' };
    const lanes = [
      liveLane,
      finishedLane('exhausted'),
      finishedLane('done'),
      finishedLane('parked'),
    ];

    const runningCount = lanes.filter((lane) => categoryOf(lane) === 'running').length;

    expect(runningCount).toBe(1);
  });

  it.each(['exhausted', 'done', 'parked', 'unverified'])(
    'never categorizes a finished lane with verdict %s as running',
    (verdict) => {
      expect(categoryOf(finishedLane(verdict))).not.toBe('running');
    },
  );
});
