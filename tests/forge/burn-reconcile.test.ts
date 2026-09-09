/**
 * P4.7/I3: the `forge up` cadence that actually calls `reconcileBurn` -- a correct,
 * tested pure function the Governor stream shipped with nothing in production invoking
 * it. Deduped per run so an unresolved mismatch is reported once, not once every 30s
 * for as long as it stays open.
 */
import { describe, expect, it } from 'vitest';

import type { FleetState } from '../../src/forge/journal.js';
import { reconcileBurnOnce } from '../../src/forge/burn-reconcile.js';

function baseState(overrides: Partial<FleetState> = {}): FleetState {
  return { events: [], runs: {}, burn: {}, handoffs: 0, torn: 0, unknownModels: [], ...overrides };
}

describe('reconcileBurnOnce', () => {
  it('reports a fresh mismatch the first time it sees one', () => {
    const state = baseState({
      events: [
        { id: '1', seq: 1, at: 1, version: 1, event: 'run.started', actor: 'runner', run: 'r1' },
        {
          id: '2', seq: 2, at: 2, version: 1, event: 'result.usage', actor: 'runner', run: 'r1',
          modelUsage: { 'claude-sonnet-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 10 } },
        },
        {
          id: '3', seq: 3, at: 3, version: 1, event: 'turn.end', actor: 'worker', run: 'r1', model: 'claude-sonnet-5',
          usage: { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 },
        },
      ],
    });
    const reported = new Set<string>();
    const events = reconcileBurnOnce(state, reported);
    expect(events).toHaveLength(1);
    expect(events[0]!['event']).toBe('burn.mismatch');
    expect([...reported]).toEqual(['r1|1000|0']);
  });

  it('never reports the same run\'s mismatch twice', () => {
    const state = baseState({
      events: [
        {
          id: '2', seq: 2, at: 2, version: 1, event: 'result.usage', actor: 'runner', run: 'r1',
          modelUsage: { 'claude-sonnet-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 10 } },
        },
      ],
    });
    const reported = new Set<string>();
    expect(reconcileBurnOnce(state, reported)).toHaveLength(1);
    expect(reconcileBurnOnce(state, reported)).toHaveLength(0);
  });

  it('after a restart, a mismatch the journal already carries with the same figures is not written again', () => {
    const state = baseState({
      events: [
        {
          id: '2', seq: 2, at: 2, version: 1, event: 'result.usage', actor: 'runner', run: 'r1',
          modelUsage: { 'claude-sonnet-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 10 } },
        },
        { id: '9', seq: 9, at: 9, version: 1, event: 'burn.mismatch', actor: 'governor', run: 'r1', resultUsd: 10, perMessageUsd: 0 },
      ],
    });
    // A fresh Set is what every `forge up` starts with.
    expect(reconcileBurnOnce(state, new Set())).toHaveLength(0);
  });

  it('writes again once the figures moved', () => {
    const state = baseState({
      events: [
        {
          id: '2', seq: 2, at: 2, version: 1, event: 'result.usage', actor: 'runner', run: 'r1',
          modelUsage: { 'claude-sonnet-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 10 } },
        },
        { id: '9', seq: 9, at: 9, version: 1, event: 'burn.mismatch', actor: 'governor', run: 'r1', resultUsd: 4, perMessageUsd: 0 },
      ],
    });
    const events = reconcileBurnOnce(state, new Set());
    expect(events).toHaveLength(1);
    expect(events[0]!['resultUsd']).toBe(10);
  });

  it('reports nothing when the two sums agree', () => {
    const state = baseState({ events: [] });
    expect(reconcileBurnOnce(state, new Set())).toHaveLength(0);
  });
});
