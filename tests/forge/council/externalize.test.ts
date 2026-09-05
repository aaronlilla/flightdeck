/**
 * Requirement: "Reconciliation-before-retry on every external write the gate makes (PR
 * open, merge, comment) via the ExternalWrite contract already in contracts.ts." No `gh`
 * call anywhere in this file: `reconcileMerge` takes a fabricated "what gh pr view would
 * have said" fixture instead of shelling out.
 */
import { describe, expect, it } from 'vitest';

import { planMergeIntent, recordMergeCall, reconcileMerge } from '../../../src/forge/council/externalize.ts';
import { mayRetryWithoutReconciling } from '../../../src/forge/contracts.ts';

describe('the merge as an ExternalWrite', () => {
  it('starts as an intent, recorded before the call is ever attempted', () => {
    const write = planMergeIntent({ repo: 'sample-app', pr: 42, headSha: 'aaa' });
    expect(write.state).toBe('intent');
    expect(mayRetryWithoutReconciling(write)).toBe(true);
  });

  it('moves to call once the gh invocation is made, and call may not be retried blind', () => {
    const intent = planMergeIntent({ repo: 'sample-app', pr: 42, headSha: 'aaa' });
    const call = recordMergeCall(intent);
    expect(call.state).toBe('call');
    expect(mayRetryWithoutReconciling(call)).toBe(false);
  });

  it('reconciles to complete when gh pr view shows MERGED', () => {
    const intent = planMergeIntent({ repo: 'sample-app', pr: 42, headSha: 'aaa' });
    const call = recordMergeCall(intent);
    const reconciled = reconcileMerge(call, { prState: 'MERGED' });
    expect(reconciled.state).toBe('complete');
  });

  it('reconciles to unknown when gh pr view is inconclusive, never straight to complete', () => {
    const intent = planMergeIntent({ repo: 'sample-app', pr: 42, headSha: 'aaa' });
    const call = recordMergeCall(intent);
    const reconciled = reconcileMerge(call, { prState: 'OPEN' });
    expect(reconciled.state).toBe('unknown');
    expect(mayRetryWithoutReconciling(reconciled)).toBe(false);
  });

  it('the same PR and head produce the same idempotency key across a planned retry', () => {
    const a = planMergeIntent({ repo: 'sample-app', pr: 42, headSha: 'aaa' });
    const b = planMergeIntent({ repo: 'sample-app', pr: 42, headSha: 'aaa' });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });
});
