import { describe, expect, it } from 'vitest';

import { visibleLanes } from '../../src/console/components/LanesGrid.js';
import type { Lane, LaneState } from '../../src/shared/console-model.js';

function lane(state: LaneState, extra: Partial<Lane> = {}): Lane {
  return {
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state, reason: null, stepN: 1, stepTotal: 6, stepText: '',
    ctxTokens: 1000, ctxCeiling: 200_000, ctxCompactAt: 180_000, costUsd: 1, capUsd: 10, burnUsdPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: false, since: 0, startedAt: 0,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    ...extra,
  };
}

// POLISH-2 #4: "today" hides a finished lane from before local midnight, and never
// touches a lane that's still live.
describe('visibleLanes today filter', () => {
  const now = new Date('2026-06-15T14:00:00').getTime();
  const yesterday = new Date('2026-06-14T23:50:00').getTime();
  const earlierToday = new Date('2026-06-15T02:00:00').getTime();

  it('hides a finished lane whose endedAt is before local midnight', () => {
    const lanes = [lane('merged', { id: 'old', endedAt: yesterday })];
    expect(visibleLanes(lanes, 'today', 'cost', now)).toHaveLength(0);
  });

  it('keeps a finished lane that ended today', () => {
    const lanes = [lane('merged', { id: 'new', endedAt: earlierToday })];
    expect(visibleLanes(lanes, 'today', 'cost', now)).toHaveLength(1);
  });

  it('never hides a still-running lane, however old its since', () => {
    const lanes = [lane('running', { id: 'stale-running', since: yesterday, endedAt: null })];
    expect(visibleLanes(lanes, 'today', 'cost', now)).toHaveLength(1);
  });

  it('falls back to since when endedAt is null', () => {
    const lanes = [lane('killed', { id: 'old-kill', since: yesterday, endedAt: null })];
    expect(visibleLanes(lanes, 'today', 'cost', now)).toHaveLength(0);
  });
});
