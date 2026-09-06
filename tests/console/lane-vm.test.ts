import { describe, expect, it } from 'vitest';

import { costClass, costTip, laneCta, stepDisplay, tileCapText } from '../../src/console/laneVM.js';
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

// HANDOFF "Board": exactly one CTA per lane state.
describe('laneCta', () => {
  const cases: Array<[LaneState, string]> = [
    ['running', 'Watch live'],
    ['parked', 'Answer →'],
    ['handed-off', 'View council'],
    ['paused', 'Resume ▶'],
    ['done', 'Merge now →'],
    ['exhausted', 'Compact + resume →'],
    ['unverified', 'Verify →'],
    ['merged', 'Open PR ↗'],
    ['killed', 'Reopen'],
  ];

  it.each(cases)('renders the one CTA the HANDOFF names for %s', (state, label) => {
    expect(laneCta(lane(state)).label).toBe(label);
  });

  it('a runaway running lane offers Kill attempt instead of Watch live', () => {
    expect(laneCta(lane('running', { runaway: true })).label).toBe('Kill attempt');
    expect(laneCta(lane('running', { runaway: true })).cls).toBe('btnR');
  });

  it('a blocked lane offers the gate log by default', () => {
    expect(laneCta(lane('blocked')).label).toBe('Gate log →');
  });

  it('a lane blocked on an integration offers reconnect instead', () => {
    expect(laneCta(lane('blocked', { blockedBy: 'aws' })).label).toBe('Reconnect AWS →');
  });
});

// POLISH-1 #1: the tile prefixes the step text with `step N/M · ` once the lane has a step total.
describe('stepDisplay', () => {
  it('prefixes the step text with step N/M when the lane has a step total', () => {
    expect(stepDisplay(lane('running', { stepN: 2, stepTotal: 9, stepText: 'retry loop' }))).toBe('step 2/9 · retry loop');
  });

  it('prints the step text bare when there is no step total', () => {
    expect(stepDisplay(lane('blocked', { stepN: 0, stepTotal: 0, stepText: 'cannot provision' }))).toBe('cannot provision');
  });
});

// POLISH-1 #2: the tile shows the cap only for a runaway lane; the sheets show it either way.
describe('tileCapText / costClass', () => {
  it('shows no cap text on a normal tile', () => {
    expect(tileCapText(lane('running', { costUsd: 4.32, capUsd: 20, runaway: false }))).toBe('');
  });

  it('shows cap $N · exceeded ×K only for a runaway lane', () => {
    expect(tileCapText(lane('running', { costUsd: 27.5, capUsd: 8, runaway: true }))).toBe('cap $8 · exceeded ×3.4');
  });

  it('renders the cost readout phosphor-off when stale, regardless of amount', () => {
    expect(costClass(lane('running', { costUsd: 27.5, capUsd: 8 }), true)).toBe('ws');
    expect(costClass(lane('running', { costUsd: 27.5, capUsd: 8 }), false)).toBe('w2');
  });
});

// POLISH-1 #6: hover cards carry a value, a source and a time, plus the click target.
describe('costTip', () => {
  it('names the value, the source and the click target', () => {
    const l = lane('running', { id: 'FLT-9', costUsd: 4.32, capUsd: 20 });
    const fresh = { verified: true, at: 1_000, ageMs: 0 };
    const tip = costTip(l, fresh);
    expect(tip.head).toBe('$4.32');
    expect(tip.body).toContain('$4.32');
    expect(tip.body).toContain('FLT-9');
    expect(tip.click).toBe('Click → cost sheet');
  });
});
