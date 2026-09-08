// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { useAction } from '../../src/console/actions.js';
import { ApiError } from '../../src/console/api.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';
import { Toast } from '../../src/console/components/Toast.js';
import { useReducer } from 'react';

/** A minimal harness: a real reducer (not a mocked dispatch), so `useAction`'s
 *  `pending-set`/`pending-clear`/`toast` dispatches actually change what renders --
 *  the same shape App.tsx gives every component in production. */
function Inner({ fn, busy, done }: { fn: () => Promise<unknown>; busy: string; done?: string | ((r: unknown) => string) }) {
  const action = useAction('test-key', fn, { busy, done });
  return (
    <span data-testid="btn" aria-busy={action.busy ? 'true' : undefined} data-busy={action.busy ? '1' : undefined} onClick={action.run}>
      {action.busy ? busy : 'go'}
    </span>
  );
}

function Harness({ fn, busy, done }: { fn: () => Promise<unknown>; busy: string; done?: string | ((r: unknown) => string) }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <Inner fn={fn} busy={busy} done={done} />
      <Toast toast={state.toast} />
    </StoreContext.Provider>
  );
}

describe('useAction', () => {
  it('renders busy while the promise is in flight and clears after it resolves', async () => {
    let resolve!: () => void;
    const fn = vi.fn(() => new Promise<unknown>((r) => { resolve = () => r({ ok: true }); }));
    render(<Harness fn={fn} busy="Doing…" />);
    await userEvent.click(screen.getByTestId('btn'));
    expect(screen.getByTestId('btn')).toHaveAttribute('data-busy', '1');
    expect(screen.getByTestId('btn')).toHaveAttribute('aria-busy', 'true');
    await act(async () => { resolve(); });
    await waitFor(() => expect(screen.getByTestId('btn')).not.toHaveAttribute('data-busy'));
  });

  it('a rejected ApiError carrying {error, reason} shows both in the toast', async () => {
    const fn = vi.fn(() => Promise.reject(new ApiError(501, 'not wired: no repo/PR on record for run x to re-audit')));
    render(<Harness fn={fn} busy="Re-auditing…" />);
    await userEvent.click(screen.getByTestId('btn'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('not wired'));
    expect(screen.getByTestId('toast')).toHaveTextContent('no repo/PR on record');
  });

  it('a rejected ApiError carrying raw JSON is parsed for both fields', async () => {
    const fn = vi.fn(() => Promise.reject(new ApiError(501, JSON.stringify({ error: 'not wired', reason: 'no repo/PR on record for run x to re-audit' }))));
    render(<Harness fn={fn} busy="Re-auditing…" />);
    await userEvent.click(screen.getByTestId('btn'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('not wired'));
    expect(screen.getByTestId('toast')).toHaveTextContent('no repo/PR on record');
  });

  it('success shows opts.done, else result.message, else "done"', async () => {
    const fn = vi.fn(() => Promise.resolve({ ok: true }));
    render(<Harness fn={fn} busy="Doing…" done="All set" />);
    await userEvent.click(screen.getByTestId('btn'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('All set'));
  });

  it('success falls back to result.message when opts.done is omitted', async () => {
    const fn = vi.fn(() => Promise.resolve({ ok: true, message: 'sent to run-1' }));
    render(<Harness fn={fn} busy="Doing…" />);
    await userEvent.click(screen.getByTestId('btn'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('sent to run-1'));
  });

  it('success falls back to "done" when neither opts.done nor result.message exist', async () => {
    const fn = vi.fn(() => Promise.resolve(42));
    render(<Harness fn={fn} busy="Doing…" />);
    await userEvent.click(screen.getByTestId('btn'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('done'));
  });

  it('calling run() again while busy does not fire fn a second time', async () => {
    let resolve!: () => void;
    const fn = vi.fn(() => new Promise<unknown>((r) => { resolve = () => r({ ok: true }); }));
    render(<Harness fn={fn} busy="Doing…" />);
    const btn = screen.getByTestId('btn');
    await userEvent.click(btn);
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
  });
});
