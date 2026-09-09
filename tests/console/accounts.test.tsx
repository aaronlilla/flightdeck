// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Accounts } from '../../src/console/components/Accounts.js';
import type { AccountItem, ConnectAttemptResponse, ConnectStartResponse, DisconnectResponse } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({
  connectAccount: vi.fn(),
  getConnectAttempt: vi.fn(),
  disconnectAccount: vi.fn(),
}));
import * as api from '../../src/console/api.js';

function account(extra: Partial<AccountItem> = {}): AccountItem {
  return { id: 'test-a', label: 'work', connectedAt: 1000, liveRuns: 0, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Accounts: the connect form', () => {
  it('renders each connect state distinctly as the attempt progresses', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    const states: ConnectAttemptResponse['state'][] = ['waiting-in-browser', 'probing', 'connected'];
    let call = 0;
    vi.mocked(api.getConnectAttempt).mockImplementation(async () => {
      const state = states[Math.min(call, states.length - 1)]!;
      call += 1;
      return { id: 'attempt-1', label: 'work', state, ...(state === 'connected' ? { accountId: 'test-a' } : {}) };
    });

    render(<Accounts accounts={[]} pollMs={1} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByTestId('connect-state')).toHaveTextContent('Connecting'));
    await waitFor(() => expect(screen.getByTestId('connect-state')).toHaveTextContent('Connected'), { timeout: 2000 });
  });

  it('disables the Connect button while a connect attempt is pending', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    vi.mocked(api.getConnectAttempt).mockResolvedValue({
      id: 'attempt-1', label: 'work', state: 'waiting-in-browser',
    } satisfies ConnectAttemptResponse);

    render(<Accounts accounts={[]} pollMs={50_000} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'work' } });
    const button = screen.getByRole('button', { name: 'Connect' });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
  });

  it('shows the captured login link once the attempt reports one', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    vi.mocked(api.getConnectAttempt).mockResolvedValue({
      id: 'attempt-1', label: 'work', state: 'waiting-in-browser', link: 'https://example.test/authorize/abc',
    } satisfies ConnectAttemptResponse);

    render(<Accounts accounts={[]} pollMs={1} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByTestId('connect-link')).toHaveAttribute(
      'href', 'https://example.test/authorize/abc',
    ));
  });

  it('shows the failure text verbatim when the attempt fails', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    vi.mocked(api.getConnectAttempt).mockResolvedValue({
      id: 'attempt-1', label: 'work', state: 'failed', error: 'not authenticated',
    } satisfies ConnectAttemptResponse);

    render(<Accounts accounts={[]} pollMs={1} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not authenticated'));
  });

  it('shows the start refusal verbatim when starting the attempt itself fails', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: false, error: 'a connect attempt for "work" is already in flight' } satisfies ConnectStartResponse);

    render(<Accounts accounts={[]} pollMs={1} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('a connect attempt for "work" is already in flight'));
    expect(api.getConnectAttempt).not.toHaveBeenCalled();
  });
});

describe('Accounts: the connected accounts list', () => {
  it('lists every account with a Disconnect button', () => {
    render(<Accounts accounts={[account({ id: 'test-a', label: 'work' }), account({ id: 'test-b', label: 'personal' })]} />);
    expect(screen.getByTestId('account-test-a')).toHaveTextContent('work');
    expect(screen.getByTestId('account-test-b')).toHaveTextContent('personal');
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(2);
  });

  it('renders the last-remaining-account refusal verbatim', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue({
      ok: false, error: 'refusing to disconnect the last remaining account',
    } satisfies DisconnectResponse);

    render(<Accounts accounts={[account()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'refusing to disconnect the last remaining account',
    ));
  });

  it('renders the live-runs refusal verbatim', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue({
      ok: false, error: 'refusing to disconnect "work": 2 run(s) still in flight on it',
    } satisfies DisconnectResponse);

    render(<Accounts accounts={[account({ liveRuns: 2 }), account({ id: 'test-b', label: 'spare' })]} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0]!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'refusing to disconnect "work": 2 run(s) still in flight on it',
    ));
  });

  it('calls onChanged once a disconnect actually succeeds', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue({ ok: true } satisfies DisconnectResponse);
    const onChanged = vi.fn();

    render(<Accounts accounts={[account(), account({ id: 'test-b', label: 'spare' })]} onChanged={onChanged} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0]!);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
