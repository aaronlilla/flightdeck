import { useCallback, useEffect, useRef, useState } from 'react';

import { ACTIONS, useAction } from './actions.js';
import type { ActionOutcome } from './store.js';

const DEBOUNCE_MS = 400;
const MIN_WIDTH = 1;
const MAX_WIDTH = 12;

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

export interface WidthStepper {
  /** What to render. The clicked value while a click is still settling; the server's
   *  own value once nothing is pending, so another actor's change is picked up. */
  value: number;
  inc: () => void;
  dec: () => void;
  /** The last `postQueueWidth` outcome, for a control that shows the server's message. */
  result: ActionOutcome | null;
}

/**
 * One shared stepper behind both `queue-width` and `settings-width`, so the two
 * controls can't drift apart. A click moves `value` at once, clamped to 1..12, with
 * no network wait; posts are debounced 400ms so a burst -- six to ten -- goes out as
 * one `postQueueWidth` call carrying the final number, never one call per click.
 *
 * `useAction` drops a `run()` while a call for the same key is already pending
 * (`state.actions[key]?.pending` in `actions.ts`), so a debounce that fires mid-flight
 * would silently lose the click. This hook queues that value instead, and re-sends it
 * itself the moment the in-flight call settles.
 *
 * While no click is pending, `value` is just `serverValue` -- so a width another actor
 * set lands on screen the same render it arrives. A rejected post drops the local
 * value outright rather than leaving a number on screen the server never accepted.
 */
export function useWidthStepper(serverValue: number): WidthStepper {
  const width = useAction(ACTIONS.postQueueWidth);
  const [local, setLocal] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedRef = useRef<number | null>(null);
  const pendingRef = useRef(width.pending);
  pendingRef.current = width.pending;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const send = useCallback((value: number) => {
    if (pendingRef.current) {
      // A call for a different value is still in flight -- run() would drop this one.
      // Hold it; the in-flight call's own settle (below) re-sends it.
      queuedRef.current = value;
      return;
    }
    queuedRef.current = null;
    void width.run(value).then((outcome) => {
      // `postQueueWidth` is reversible, so it never actually produces a `confirm`
      // outcome -- but the type is shared with gated actions, so narrow anyway.
      if (outcome.kind !== 'done' || !outcome.ok) {
        // The server never accepted this value -- never leave it on screen.
        setLocal(null);
        return;
      }
      // Done editing unless a newer click already moved `value` past what we just sent.
      setLocal((current) => (current === value ? null : current));
      const queued = queuedRef.current;
      if (queued !== null && queued !== value) {
        queuedRef.current = null;
        send(queued);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const step = useCallback((delta: number) => {
    setLocal((current) => {
      const next = clamp((current ?? serverValue) + delta);
      clearTimer();
      timerRef.current = setTimeout(() => send(next), DEBOUNCE_MS);
      return next;
    });
  }, [serverValue, send, clearTimer]);

  return {
    value: local ?? serverValue,
    inc: useCallback(() => step(1), [step]),
    dec: useCallback(() => step(-1), [step]),
    result: width.result,
  };
}
