/**
 * One action-feedback contract every button that talks to the server goes through:
 * busy state in the store's `pending` map while the request is in flight, a toast
 * on success or failure, and a guard against firing the same action twice while
 * it is already running. Written after a live measurement found a 6.6s Re-check
 * and a swallowed 501 on Re-audit both rendering as nothing happening at all.
 */
import { useCallback, useRef } from 'react';

import * as api from './api.js';
import { useStore } from './store.js';
import type { Action } from './store.js';

const SUCCESS_TOAST_MS = 4_000;
const FAILURE_TOAST_MS = 8_000;

export interface ActionOptions {
  /** Shown on the busy button and (with an elapsed-seconds suffix) in the top bar. */
  busy: string;
  /** Success toast text. A string, a function of the resolved value, or omitted --
   *  in which case the result's own `message` field wins, falling back to "done". */
  done?: string | ((result: unknown) => string);
}

export interface ActionHandle {
  run: () => void;
  busy: boolean;
}

/** The text an `ApiError` (or any other rejection) should show in a toast. A fresh
 *  `ApiError` already carries the server's `error`/`reason` folded into one string
 *  (see `redactErrorBody` in redact.ts), but this parses defensively in case the
 *  message is still raw `{"error":...,"reason":...}` JSON -- an older code path, or
 *  a test's own mocked rejection -- so neither field is ever dropped on the floor. */
export function errorText(error: unknown): string {
  if (error instanceof api.ApiError) {
    const raw = error.message;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; reason?: unknown };
      if (typeof parsed.error === 'string') {
        return typeof parsed.reason === 'string' ? `${parsed.error}: ${parsed.reason}` : parsed.error;
      }
    } catch {
      // Not JSON -- `raw` is already the human text redactErrorBody produced.
    }
    return raw;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function doneText(opts: ActionOptions, result: unknown): string {
  if (opts.done) return typeof opts.done === 'function' ? opts.done(result) : opts.done;
  if (result && typeof result === 'object' && typeof (result as { message?: unknown }).message === 'string') {
    return (result as { message: string }).message;
  }
  return 'done';
}

/** Shows a toast and clears it after the usual window -- green success (4s), red
 *  failure (8s, so a longer error actually gets read). Shared by `useAction` and by
 *  every call site (`runAction`, `runQueueAction`, the reaudit poll) that needs the
 *  same toast without going through the single-promise shape `useAction` assumes. */
export function showToast(dispatch: (action: Action) => void, text: string, ok: boolean): void {
  dispatch({ type: 'toast', toast: { glyph: ok ? '✓' : '✕', title: text, sub: '', big: '', color: ok ? undefined : 'var(--block)' } });
  setTimeout(() => dispatch({ type: 'toast', toast: null }), ok ? SUCCESS_TOAST_MS : FAILURE_TOAST_MS);
}

/**
 * Wraps one mutating call: while `fn` is in flight, `key` is marked busy in the
 * store's `pending` map (so the top bar and any button watching that key render
 * it), and it always ends in a toast -- never a swallowed failure. `run()` is a
 * no-op while the same key is already pending, so an impatient second click (or a
 * double-fired keyboard Enter) never sends the request twice.
 */
export function useAction(key: string, fn: () => Promise<unknown>, opts: ActionOptions): ActionHandle {
  const { state, dispatch } = useStore();
  const inFlightRef = useRef(false);
  const run = useCallback(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    dispatch({ type: 'pending-set', key, label: opts.busy });
    fn().then(
      (result) => {
        dispatch({ type: 'pending-clear', key });
        showToast(dispatch, doneText(opts, result), true);
      },
      (error: unknown) => {
        dispatch({ type: 'pending-clear', key });
        showToast(dispatch, errorText(error), false);
      },
    ).finally(() => { inFlightRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fn, opts.busy, opts.done, dispatch]);
  return { run, busy: key in state.pending };
}
