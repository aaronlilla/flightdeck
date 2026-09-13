// @vitest-environment jsdom
/**
 * The one control on the machine's own login row.
 *
 * Aaron, 2026-09-12: "i have no way to unlink the other account, which i should be able
 * to." That row had no Unlink and no use controls, because it has no registry entry to
 * patch. What it has now is a switch that takes the login out of the rotation and leaves
 * it signed in -- and, since it is the only login a machine with no linked account has,
 * the switch is not offered while there is no other Claude login to fall back to.
 *
 * Asserted on what reaches the server, like its sibling file: a row that renders a state
 * the server refused is the failure worth catching, and pixels are nobody's business.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-09-12T12:00:00Z');

import { Accounts } from '../../src/console/components/Accounts.js';
import type { AccountItem } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({
  connectAccount: vi.fn(),
  getConnectAttempt: vi.fn(),
  disconnectAccount: vi.fn(),
  updateAccount: vi.fn(async () => ({ ok: true })),
  setDefaultLoginOff: vi.fn(async () => ({ ok: true })),
  deleteLeftover: vi.fn(async () => ({ ok: true, bytes: 0 })),
  isConfirmPending: (r: unknown) => typeof r === 'object' && r !== null && 'pending' in r,
  getLeftovers: vi.fn(async () => ({ items: [] })),
}));
import * as api from '../../src/console/api.js';

const machineLogin: AccountItem = {
  id: 'fleet', provider: 'claude', email: 'machine@example.com',
  connectedAt: 0, liveRuns: 0, windows: [], fleet: true,
};

const linked: AccountItem = {
  id: 'linked', provider: 'claude', email: 'work@example.com',
  connectedAt: 1000, liveRuns: 0, windows: [],
};

describe('the machine\'s own login row', () => {
  it('offers no switch while it is the only Claude login there is', () => {
    render(<Accounts now={NOW} accounts={[machineLogin]} />);
    expect(screen.queryByTestId('default-login-off')).toBeNull();
    expect(screen.queryByTestId('default-login-on')).toBeNull();
  });

  it('offers no switch when the only other login is a ChatGPT one', () => {
    render(<Accounts now={NOW} accounts={[
      machineLogin,
      { id: 'gpt', provider: 'codex', email: 'work@example.com', connectedAt: 1, liveRuns: 0, windows: [] },
    ]} />);
    expect(screen.queryByTestId('default-login-off')).toBeNull();
  });

  it('never offers Unlink, because there is no registry row to remove', () => {
    render(<Accounts now={NOW} accounts={[machineLogin, linked]} />);
    // One Unlink on the page: the linked row's. The machine's own row has none.
    expect(screen.getAllByText('Unlink')).toHaveLength(1);
  });

  it('switches the login off, and says which way round it is now', async () => {
    render(<Accounts now={NOW} accounts={[machineLogin, linked]} />);
    expect(screen.getByTestId('default-login-on').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('default-login-off'));
    await waitFor(() => { expect(api.setDefaultLoginOff).toHaveBeenCalledWith(true); });
  });

  it('reads as off once the server says it is, and switches back on', async () => {
    render(<Accounts now={NOW} accounts={[{ ...machineLogin, off: true }, linked]} />);
    expect(screen.getByTestId('default-login-off').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('default-login-on').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/switched off/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('default-login-on'));
    await waitFor(() => { expect(api.setDefaultLoginOff).toHaveBeenCalledWith(false); });
  });

  it('shows the server\'s refusal on the row rather than pretending it worked', async () => {
    vi.mocked(api.setDefaultLoginOff).mockResolvedValueOnce({
      ok: false, error: 'link a Claude account first; this is the only login the machine has',
    });
    render(<Accounts now={NOW} accounts={[machineLogin, linked]} />);

    fireEvent.click(screen.getByTestId('default-login-off'));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/link a Claude account first/);
    });
  });
});
