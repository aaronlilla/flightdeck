/**
 * Requirement 3 — `ExternalWrite` with reconcile before retry (roadmap:113; spine spec
 * "F8... accepted into `ExternalWrite` as 'missing completion means unknown, reconcile
 * before retry'"). `contracts.ts` already has the state machine's shape and
 * `mayRetryWithoutReconciling`; this module is Intake's own caller of it — the part
 * that actually performs a write, catches a mid-flight failure, and refuses to retry
 * until a reconciler has looked.
 *
 * The fake Jira sink here is the ONLY thing this stream ever calls for a Jira write; no
 * live call anywhere in this file.
 */
import { describe, expect, it, vi } from 'vitest';

import { performExternalWrite, reconcileAndMaybeRetry } from '../../../src/forge/intake/externalWrite.js';

describe('performExternalWrite', () => {
  it('records intent, then call, then complete on a clean write', async () => {
    const records: string[] = [];
    const sink = vi.fn(async () => 'ok');
    const write = await performExternalWrite(
      { id: 'w1', kind: 'jira.comment', idempotencyKey: 'ik-1' },
      sink,
      (state) => records.push(state),
    );
    expect(records).toEqual(['intent', 'call', 'complete']);
    expect(write.state).toBe('complete');
  });

  it('a call that throws after leaving the process records `unknown`, never `failed` or `complete`', async () => {
    const records: string[] = [];
    const sink = vi.fn(async () => { throw new Error('ECONNRESET after send'); });
    const write = await performExternalWrite(
      { id: 'w2', kind: 'jira.comment', idempotencyKey: 'ik-2' },
      sink,
      (state) => records.push(state),
    );
    expect(records).toEqual(['intent', 'call', 'unknown']);
    expect(write.state).toBe('unknown');
  });
});

describe('reconcileAndMaybeRetry — reconcile before retry', () => {
  it('an `unknown` write is retried ONLY after reconciliation confirms the call never landed', async () => {
    const unknown = { id: 'w2', kind: 'jira.comment', idempotencyKey: 'ik-2', state: 'unknown' as const, at: 1 };
    const reconcile = vi.fn(async () => ({ landed: false }));
    const sink = vi.fn(async () => 'ok');
    const result = await reconcileAndMaybeRetry(unknown, reconcile, sink);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('complete');
  });

  it('an `unknown` write whose call DID land is marked complete without a second write', async () => {
    const unknown = { id: 'w2', kind: 'jira.comment', idempotencyKey: 'ik-2', state: 'unknown' as const, at: 1 };
    const reconcile = vi.fn(async () => ({ landed: true }));
    const sink = vi.fn(async () => 'ok');
    const result = await reconcileAndMaybeRetry(unknown, reconcile, sink);
    expect(sink).not.toHaveBeenCalled();
    expect(result.state).toBe('complete');
  });

  it('falsifier guard: a naive retry that skips reconciliation is exactly what this function refuses to be — an `intent` write goes straight through with no reconcile call', async () => {
    // mayRetryWithoutReconciling(intent) === true; this proves the function actually
    // consults that rule rather than always reconciling first.
    const intent = { id: 'w3', kind: 'jira.comment', idempotencyKey: 'ik-3', state: 'intent' as const, at: 1 };
    const reconcile = vi.fn(async () => ({ landed: false }));
    const sink = vi.fn(async () => 'ok');
    const result = await reconcileAndMaybeRetry(intent, reconcile, sink);
    expect(reconcile).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('complete');
  });
});
