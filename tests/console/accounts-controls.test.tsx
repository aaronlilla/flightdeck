// @vitest-environment jsdom
/**
 * The Settings row's spending controls, the spent-provider warning, and the leftover
 * logins left on disk after an unlink.
 *
 * Everything here asserts what reaches the SERVER, not what the row looks like: the
 * registry decides, and a control that renders a value the registry refused is the
 * failure this file exists to catch. Pixels are nobody's business here.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-09-10T12:00:00Z');

import { Accounts } from '../../src/console/components/Accounts.js';
import type { AccountItem } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({
  connectAccount: vi.fn(),
  getConnectAttempt: vi.fn(),
  disconnectAccount: vi.fn(),
  updateAccount: vi.fn(async () => ({ ok: true })),
  deleteLeftover: vi.fn(async () => ({ ok: true, bytes: 0 })),
  isConfirmPending: (r: unknown) => typeof r === 'object' && r !== null && 'pending' in r,
  getLeftovers: vi.fn(async () => ({ items: [] })),
}));
import * as api from '../../src/console/api.js';

function account(extra: Partial<AccountItem> = {}): AccountItem {
  return { id: 'test-a', provider: 'claude', connectedAt: 1000, liveRuns: 0, windows: [], ...extra };
}

describe('how much of a login the fleet may take', () => {
  it('reads "no limit" when no ceiling is set, which is the default for a new row', () => {
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);
    expect(screen.getByTestId('ceiling-test-a').textContent).toBe('no limit');
  });

  it('marks Freely pressed on an ordinary row and Hold back on a held-back one', () => {
    render(<Accounts now={NOW} accounts={[
      account({ id: 'test-a', email: 'work@example.com' }),
      account({ id: 'test-b', email: 'mine@example.com', lastResort: true }),
    ]} />);
    expect(screen.getByTestId('use-freely-test-a').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('hold-back-test-a').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('hold-back-test-b').getAttribute('aria-pressed')).toBe('true');
  });

  it('holds an account back through the one patch route', async () => {
    const onChanged = vi.fn();
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('hold-back-test-a'));

    await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith('test-a', { lastResort: true }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('raises the ceiling from no limit to 1', async () => {
    vi.mocked(api.updateAccount).mockClear();
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);

    fireEvent.click(screen.getByTestId('ceiling-up-test-a'));

    await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith('test-a', { maxConcurrent: 1 }));
  });

  it('sends 0 to clear the ceiling and never a negative number', async () => {
    vi.mocked(api.updateAccount).mockClear();
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com', maxConcurrent: 1 })]} />);

    fireEvent.click(screen.getByTestId('ceiling-down-test-a'));
    await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith('test-a', { maxConcurrent: 0 }));

    // Clicking down again at "no limit" must still send 0, never -1: the registry
    // refuses anything that is not a positive integer, and a UI that can generate a
    // refusable value is a UI that will.
    vi.mocked(api.updateAccount).mockClear();
    fireEvent.click(screen.getByTestId('ceiling-down-test-a'));
    await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith('test-a', { maxConcurrent: 0 }));
  });

  it('shows the registry refusal verbatim and does not pretend the change landed', async () => {
    vi.mocked(api.updateAccount).mockResolvedValueOnce({
      ok: false, error: "account 'test-a' has a maxConcurrent that is not a positive integer",
    });
    const onChanged = vi.fn();
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('ceiling-up-test-a'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(
      "account 'test-a' has a maxConcurrent that is not a positive integer",
    ));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('offers neither control on the machine login, which has no registry row to patch', () => {
    render(<Accounts now={NOW} accounts={[
      account({ id: 'fleet', email: 'me@example.com', fleet: true }),
      account({ id: 'test-a', email: 'work@example.com' }),
    ]} />);
    expect(screen.queryByTestId('account-controls-fleet')).toBeNull();
    expect(screen.getByTestId('account-controls-test-a')).toBeTruthy();
  });
});

describe('every account of a provider spent', () => {
  const limited = { limitedUntil: NOW + 3 * 60 * 60 * 1000, limitedWindow: 'five_hour' as const };

  it('says new runs will not start', () => {
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com', ...limited })]} />);
    const banner = screen.getByTestId('accounts-spent-claude');
    expect(banner.textContent).toContain('Claude: every account spent');
    expect(banner.textContent).toContain('no new runs');
  });

  it('stays quiet while one account of that provider is still usable', () => {
    render(<Accounts now={NOW} accounts={[
      account({ id: 'test-a', email: 'work@example.com', ...limited }),
      account({ id: 'test-b', email: 'spare@example.com' }),
    ]} />);
    expect(screen.queryByTestId('accounts-spent-claude')).toBeNull();
  });

  it('does not count the machine login as a linked account', () => {
    render(<Accounts now={NOW} accounts={[
      account({ id: 'fleet', email: 'me@example.com', fleet: true }),
      account({ id: 'test-a', email: 'work@example.com', ...limited }),
    ]} />);
    expect(screen.getByTestId('accounts-spent-claude')).toBeTruthy();
  });

  it('warns per provider, never across them', () => {
    render(<Accounts now={NOW} accounts={[
      account({ id: 'test-a', email: 'work@example.com', ...limited }),
      account({ id: 'cx', provider: 'codex', email: 'gpt@example.com' }),
    ]} />);
    expect(screen.getByTestId('accounts-spent-claude')).toBeTruthy();
    expect(screen.queryByTestId('accounts-spent-codex')).toBeNull();
  });

  it('counts a row at its concurrency ceiling as spent too', () => {
    render(<Accounts now={NOW} accounts={[
      account({ email: 'work@example.com', maxConcurrent: 2, liveRuns: 2 }),
    ]} />);
    expect(screen.getByTestId('accounts-spent-claude')).toBeTruthy();
  });
});

describe('logins left on disk after an unlink', () => {
  it('shows nothing when there are none', async () => {
    vi.mocked(api.getLeftovers).mockResolvedValue({ items: [] });
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);
    await waitFor(() => expect(api.getLeftovers).toHaveBeenCalled());
    expect(screen.queryByTestId('leftovers')).toBeNull();
  });

  it('lists a leftover with its size', async () => {
    vi.mocked(api.getLeftovers).mockResolvedValue({ items: [{ name: 'claude-old', bytes: 740_000_000 }] });
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);
    await waitFor(() => expect(screen.getByTestId('leftover-claude-old').textContent).toContain('740 MB'));
  });

  it('asks once, naming the size, before deleting anything', async () => {
    vi.mocked(api.getLeftovers).mockResolvedValue({ items: [{ name: 'claude-old', bytes: 740_000_000 }] });
    vi.mocked(api.deleteLeftover).mockClear();
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);
    await waitFor(() => expect(screen.getByTestId('leftover-delete-claude-old')).toBeTruthy());

    vi.mocked(api.deleteLeftover).mockResolvedValueOnce({
      ok: false, pending: true, token: 'tok-1', blast: 'delete the login files', card: {} as never,
    });
    fireEvent.click(screen.getByTestId('leftover-delete-claude-old'));

    // The first call is the gate, not the delete: the server answered 202 with a token.
    await waitFor(() => expect(screen.getByTestId('leftover-claude-old').textContent).toContain('Delete 740 MB for good?'));
    expect(api.deleteLeftover).toHaveBeenCalledWith('claude-old', undefined);
  });

  it('deletes by NAME once confirmed, never by a path', async () => {
    vi.mocked(api.getLeftovers).mockResolvedValue({ items: [{ name: 'claude-old', bytes: 1000 }] });
    vi.mocked(api.deleteLeftover).mockClear();
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);
    await waitFor(() => expect(screen.getByTestId('leftover-delete-claude-old')).toBeTruthy());

    vi.mocked(api.deleteLeftover).mockResolvedValueOnce({
      ok: false, pending: true, token: 'tok-1', blast: 'delete the login files', card: {} as never,
    });
    fireEvent.click(screen.getByTestId('leftover-delete-claude-old'));
    await waitFor(() => expect(screen.getByTestId('leftover-confirm-claude-old')).toBeTruthy());
    fireEvent.click(screen.getByTestId('leftover-confirm-claude-old'));

    // Second pass carries the server's token, and the thing named is a NAME, not a path.
    await waitFor(() => expect(api.deleteLeftover).toHaveBeenCalledWith('claude-old', 'tok-1'));
    expect(vi.mocked(api.deleteLeftover).mock.calls[0]![0]).not.toContain('/');
  });

  it('shows the server refusal verbatim', async () => {
    vi.mocked(api.getLeftovers).mockResolvedValue({ items: [{ name: 'claude-old', bytes: 1000 }] });
    vi.mocked(api.deleteLeftover)
      .mockResolvedValueOnce({ ok: false, pending: true, token: 'tok-1', blast: 'delete', card: {} as never })
      .mockResolvedValueOnce({ ok: false, error: "'claude-old' is still linked; unlink the account first" });
    render(<Accounts now={NOW} accounts={[account({ email: 'work@example.com' })]} />);
    await waitFor(() => expect(screen.getByTestId('leftover-delete-claude-old')).toBeTruthy());

    fireEvent.click(screen.getByTestId('leftover-delete-claude-old'));
    await waitFor(() => expect(screen.getByTestId('leftover-confirm-claude-old')).toBeTruthy());
    fireEvent.click(screen.getByTestId('leftover-confirm-claude-old'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(
      "'claude-old' is still linked; unlink the account first",
    ));
  });
});
