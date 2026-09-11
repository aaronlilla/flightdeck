// @vitest-environment jsdom
/**
 * The Chrome header's Full re-sync and start button (R-71): confirm-gated through the
 * same `Gated`/`isConfirmPending` machinery every other irreversible action uses.
 */
import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/console/api.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/console/api.js')>('../../src/console/api.js');
  return { ...actual, fullResync: vi.fn(), isConfirmPending: actual.isConfirmPending };
});
import * as api from '../../src/console/api.js';
import { Chrome } from '../../src/console/components/Chrome.js';
import { ActionsContext } from '../../src/console/actions.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <ActionsContext.Provider value={{ refreshSlices: () => undefined, follow: () => undefined, release: () => undefined }}>
        {children}
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}

function renderChrome(): void {
  render(
    <Wrapper>
      <Chrome view="board" badges={{}} feed={{ live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: null }} project={null} now={Date.now()} onNav={() => undefined} />
    </Wrapper>,
  );
}

describe('the Full re-sync and start button', () => {
  it('renders the gate text on the first click, before anything runs', async () => {
    vi.mocked(api.fullResync).mockResolvedValueOnce({
      ok: false, pending: true, token: 'tok-1', blast: 'stops every worker and wipes the queue',
      card: { k: 'c1', type: 'confirm', text: 'confirm?', ts: Date.now(), source: 'console' },
    });
    renderChrome();
    fireEvent.click(screen.getByTestId('full-resync'));
    await waitFor(() => expect(screen.getByTestId('full-resync-gate').textContent).toBe('stops every worker and wipes the queue'));
    expect(api.fullResync).toHaveBeenCalledTimes(1);
    expect(api.fullResync).toHaveBeenCalledWith(undefined);
  });

  it('posts the confirm token on the second click and renders re-sync started', async () => {
    vi.mocked(api.fullResync).mockResolvedValueOnce({
      ok: false, pending: true, token: 'tok-2', blast: 'stops every worker and wipes the queue',
      card: { k: 'c2', type: 'confirm', text: 'confirm?', ts: Date.now(), source: 'console' },
    });
    renderChrome();
    fireEvent.click(screen.getByTestId('full-resync'));
    await waitFor(() => screen.getByTestId('full-resync-gate'));

    vi.mocked(api.fullResync).mockResolvedValueOnce({ started: true, id: 'run-1' });
    fireEvent.click(screen.getByTestId('full-resync-confirm'));
    await waitFor(() => expect(screen.getByTestId('full-resync-result').textContent).toBe('re-sync started'));
    expect(api.fullResync).toHaveBeenLastCalledWith('tok-2');
  });

  it('disables the button while a full run is running', () => {
    render(
      <Wrapper>
        <Chrome
          view="board" badges={{}} feed={{ live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: null }}
          project={null} now={Date.now()} onNav={() => undefined}
          syncFullRunning
        />
      </Wrapper>,
    );
    const button = screen.getByTestId('full-resync') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/running/i);
  });

  it('renders "already running" on a 409', async () => {
    const { ApiError } = await vi.importActual<typeof import('../../src/console/api.js')>('../../src/console/api.js');
    vi.mocked(api.fullResync).mockRejectedValueOnce(new ApiError(409, 'already running'));
    renderChrome();
    fireEvent.click(screen.getByTestId('full-resync'));
    await waitFor(() => expect(screen.getByTestId('full-resync-result').textContent).toBe('already running'));
  });
});

describe('Queue paused visibility', () => {
  it('shows "Queue paused" beside the queue indicator when queuePaused is true and the queue is on', () => {
    render(
      <Wrapper>
        <Chrome view="board" badges={{}} feed={{ live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: null }} project={null} queueOn queuePaused now={Date.now()} onNav={() => undefined} />
      </Wrapper>,
    );
    expect(screen.getByTestId('queue-paused').textContent).toBe('Queue paused');
  });

  it('does not show the label when the queue is not paused', () => {
    render(
      <Wrapper>
        <Chrome view="board" badges={{}} feed={{ live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: null }} project={null} queueOn now={Date.now()} onNav={() => undefined} />
      </Wrapper>,
    );
    expect(screen.queryByTestId('queue-paused')).toBeNull();
  });
});
