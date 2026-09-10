// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-09-09T12:00:00Z');

import { Accounts } from '../../src/console/components/Accounts.js';
import type { AccountItem, ConnectAttemptResponse, ConnectStartResponse, DisconnectResponse } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({
  connectAccount: vi.fn(),
  getConnectAttempt: vi.fn(),
  disconnectAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteLeftover: vi.fn(),
  getLeftovers: vi.fn(async () => ({ items: [] })),
}));
import * as api from '../../src/console/api.js';

function account(extra: Partial<AccountItem> = {}): AccountItem {
  return { id: 'test-a', provider: 'claude', connectedAt: 1000, liveRuns: 0, windows: [], ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Accounts: linking a provider', () => {
  it('renders each connect state distinctly as the attempt progresses', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    const states: ConnectAttemptResponse['state'][] = ['waiting-in-browser', 'probing', 'connected'];
    let call = 0;
    vi.mocked(api.getConnectAttempt).mockImplementation(async () => {
      const state = states[Math.min(call, states.length - 1)]!;
      call += 1;
      return { id: 'attempt-1', provider: 'claude', state, ...(state === 'connected' ? { accountId: 'test-a' } : {}) };
    });

    render(<Accounts now={NOW} accounts={[]} pollMs={1} />);
    fireEvent.click(screen.getByTestId('link-claude'));

    await waitFor(() => expect(screen.getByTestId('connect-state')).toHaveTextContent('Connecting'));
    await waitFor(() => expect(screen.queryByTestId('connect-pending')).toBeNull(), { timeout: 2000 });
  });

  it('disables both link buttons while a connect attempt is pending', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    vi.mocked(api.getConnectAttempt).mockResolvedValue({
      id: 'attempt-1', provider: 'claude', state: 'waiting-in-browser',
    } satisfies ConnectAttemptResponse);

    render(<Accounts now={NOW} accounts={[]} pollMs={50_000} />);
    fireEvent.click(screen.getByTestId('link-claude'));

    await waitFor(() => expect(screen.getByTestId('link-claude')).toBeDisabled());
    expect(screen.getByTestId('link-codex')).toBeDisabled();
  });

  it('shows the captured login link once the attempt reports one', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    vi.mocked(api.getConnectAttempt).mockResolvedValue({
      id: 'attempt-1', provider: 'claude', state: 'waiting-in-browser', link: 'https://example.test/authorize/abc',
    } satisfies ConnectAttemptResponse);

    render(<Accounts now={NOW} accounts={[]} pollMs={1} />);
    fireEvent.click(screen.getByTestId('link-claude'));

    await waitFor(() => expect(screen.getByTestId('connect-link')).toHaveAttribute(
      'href', 'https://example.test/authorize/abc',
    ));
    expect(screen.getByTestId('connect-link')).toHaveTextContent('Open the login page');
  });

  it('shows the failure text verbatim when the attempt fails', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    vi.mocked(api.getConnectAttempt).mockResolvedValue({
      id: 'attempt-1', provider: 'codex', state: 'failed', error: 'not authenticated',
    } satisfies ConnectAttemptResponse);

    render(<Accounts now={NOW} accounts={[]} pollMs={1} />);
    fireEvent.click(screen.getByTestId('link-codex'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not authenticated'));
  });

  it('shows the start refusal verbatim when starting the attempt itself fails', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: false, error: 'a connect attempt is already in flight' } satisfies ConnectStartResponse);

    render(<Accounts now={NOW} accounts={[]} pollMs={1} />);
    fireEvent.click(screen.getByTestId('link-claude'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('a connect attempt is already in flight'));
    expect(api.getConnectAttempt).not.toHaveBeenCalled();
  });

  it('stops polling when Cancel is clicked on the pending row', async () => {
    vi.mocked(api.connectAccount).mockResolvedValue({ ok: true, attemptId: 'attempt-1' } satisfies ConnectStartResponse);
    vi.mocked(api.getConnectAttempt).mockResolvedValue({
      id: 'attempt-1', provider: 'claude', state: 'waiting-in-browser',
    } satisfies ConnectAttemptResponse);

    render(<Accounts now={NOW} accounts={[]} pollMs={5} />);
    fireEvent.click(screen.getByTestId('link-claude'));
    await waitFor(() => expect(screen.getByTestId('connect-pending')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('connect-pending')).toBeNull();
    const callsAtCancel = vi.mocked(api.getConnectAttempt).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(vi.mocked(api.getConnectAttempt).mock.calls.length).toBe(callsAtCancel);
  });
});

describe('Accounts: the linked accounts list', () => {
  it('names each row by its email', () => {
    render(<Accounts now={NOW} accounts={[
      account({ id: 'test-a', email: 'work@example.com' }),
      account({ id: 'test-b', provider: 'codex', email: 'personal@example.com' }),
    ]} />);
    expect(screen.getByTestId('account-test-a')).toHaveTextContent('work@example.com');
    expect(screen.getByTestId('account-test-b')).toHaveTextContent('personal@example.com');
    expect(screen.getAllByRole('button', { name: 'Unlink' })).toHaveLength(2);
  });

  it('shows each window\'s percent and its reset time', () => {
    render(<Accounts now={NOW} accounts={[account({
      id: 'test-a', email: 'work@example.com',
      windows: [
        { key: 'session', label: 'Session', usedPct: 12, resetsAt: NOW + 3 * 3_600_000 },
        { key: 'weekly', label: 'Weekly', usedPct: 41, resetsAt: NOW + 5 * 86_400_000 },
      ],
    })]} />);
    const cell = screen.getByTestId('account-windows-test-a');
    expect(cell).toHaveTextContent('12% used');
    expect(cell).toHaveTextContent('41% used');
    expect(cell).toHaveTextContent('resets');
  });

  it('gives a fleet row no Unlink button', () => {
    render(<Accounts now={NOW} accounts={[account({ id: 'fleet', email: 'aaron@example.com', fleet: true })]} />);
    expect(screen.getByTestId('account-fleet')).not.toHaveTextContent('Unlink');
    expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
  });

  it('reports a readError as limits unavailable', () => {
    render(<Accounts now={NOW} accounts={[account({ id: 'test-a', email: 'work@example.com', readError: 'the probe timed out' })]} />);
    expect(screen.getByTestId('account-windows-test-a')).toHaveTextContent('limits unavailable');
    expect(screen.getByTestId('account-windows-test-a')).toHaveTextContent('the probe timed out');
  });

  it('renders the last-remaining-account refusal verbatim', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue({
      ok: false, error: 'refusing to disconnect the last remaining account',
    } satisfies DisconnectResponse);

    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'refusing to disconnect the last remaining account',
    ));
  });

  it('renders the live-runs refusal verbatim', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue({
      ok: false, error: 'refusing to disconnect: 2 run(s) still in flight on it',
    } satisfies DisconnectResponse);

    render(<Accounts now={NOW} accounts={[
      account({ id: 'test-a', email: 'work@example.com', liveRuns: 2 }),
      account({ id: 'test-b', email: 'spare@example.com' }),
    ]} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]!);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'refusing to disconnect: 2 run(s) still in flight on it',
    ));
  });

  it('calls onChanged once a disconnect actually succeeds', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue({ ok: true } satisfies DisconnectResponse);
    const onChanged = vi.fn();

    render(<Accounts now={NOW} accounts={[
      account({ id: 'test-a', email: 'work@example.com' }),
      account({ id: 'test-b', email: 'spare@example.com' }),
    ]} onChanged={onChanged} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]!);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
