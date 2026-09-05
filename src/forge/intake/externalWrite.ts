/**
 * Intake's own caller of `contracts.ts`'s `ExternalWrite` state machine (requirement 3):
 * record `intent` before a call is attempted, `call` as it goes out, `complete` when the
 * sink returns, `unknown` when the sink throws or times out — because at that point
 * nobody knows whether the other side received it. `mayRetryWithoutReconciling` is the
 * gate every retry path in this stream goes through before touching the sink again.
 */
import {
  mayRetryWithoutReconciling,
  type ExternalWrite, type ExternalWriteState,
} from '../contracts.js';

export type ExternalWriteSink = (payload: unknown) => Promise<unknown>;

export interface ReconcileResult {
  /** True when the external system shows the write already landed. */
  landed: boolean;
}

export type Reconciler = (write: ExternalWrite) => Promise<ReconcileResult>;

function stamp(id: string, kind: string, idempotencyKey: string, state: ExternalWriteState, cause?: string): ExternalWrite {
  return { id, kind, idempotencyKey, state, at: Date.now(), ...(cause ? { cause } : {}) };
}

/**
 * Attempts one external write, walking `intent -> call -> complete|unknown`.
 *
 * `onState` is called with each state in order, so a caller (the journal, a test) can
 * observe every transition rather than only the final one — the sequence itself is part
 * of the contract this closes: a write that never passed through `intent` before `call`
 * is exactly the "posted twice on a retry" bug this whole seam exists to prevent.
 */
export async function performExternalWrite(
  input: { id: string; kind: string; idempotencyKey: string },
  sink: ExternalWriteSink,
  onState?: (state: ExternalWriteState) => void,
): Promise<ExternalWrite> {
  onState?.('intent');
  let write = stamp(input.id, input.kind, input.idempotencyKey, 'intent');
  onState?.('call');
  write = stamp(input.id, input.kind, input.idempotencyKey, 'call');
  try {
    await sink(write);
  } catch (error) {
    onState?.('unknown');
    return stamp(input.id, input.kind, input.idempotencyKey, 'unknown', (error as Error).message);
  }
  onState?.('complete');
  return stamp(input.id, input.kind, input.idempotencyKey, 'complete');
}

/**
 * Retries a write that did not reach `complete` on the first attempt — the reconcile-
 * before-retry half of requirement 3. `intent` (nothing was ever sent) skips straight to
 * a fresh attempt, per `mayRetryWithoutReconciling`; `call` and `unknown` go through the
 * reconciler first, and are retried only when it reports the write never landed.
 */
export async function reconcileAndMaybeRetry(
  write: ExternalWrite,
  reconcile: Reconciler,
  sink: ExternalWriteSink,
): Promise<ExternalWrite> {
  if (mayRetryWithoutReconciling(write)) {
    return performExternalWrite(write, sink);
  }
  const outcome = await reconcile(write);
  if (outcome.landed) {
    return { ...write, state: 'complete', at: Date.now() };
  }
  return performExternalWrite(write, sink);
}
