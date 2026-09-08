// @vitest-environment jsdom
/**
 * `BlockersView`: chain ordering, later steps dimmed and disabled until the step above
 * clears, the checking/not-yet renderings, and the empty state.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BlockersView } from '../../src/console/components/BlockersView.js';
import type { Blocker, BlockersActionResult } from '../../src/shared/console-model.js';

function billingChain(): { blockers: Blocker[]; chains: string[][] } {
  const lane = { laneId: 'S-run1', label: 'the stale-session fix' };
  const now = Date.now();
  const billing: Blocker = {
    id: 'billing:aaronlilla/flightdeck', kind: 'billing', title: 'GitHub Actions billing is off for aaronlilla/flightdeck',
    detail: 'The verify jobs on PR #39 were refused.', youCanResolve: true,
    howToResolve: 'Turn billing back on, then click Resolved.', links: [], blocks: [lane], blockedBy: [],
    state: 'open', since: now, checkedAt: null, resolvedAt: null,
    thenWhat: 'Re-runs the checks on PR #39, then resumes the stale-session fix.', lastCheck: null,
  };
  const checks: Blocker = {
    id: 'checks:aaronlilla/flightdeck#39', kind: 'checks', title: 'Checks failing on PR #39 (aaronlilla/flightdeck)',
    detail: 'PR #39 has failing checks.', youCanResolve: true, howToResolve: 'Fix and push, or click Resolved.',
    links: [], blocks: [lane], blockedBy: ['billing:aaronlilla/flightdeck'], state: 'open', since: now,
    checkedAt: null, resolvedAt: null, thenWhat: 'Resumes the stale-session fix.', lastCheck: null,
  };
  return {
    blockers: [billing, checks],
    chains: [['billing:aaronlilla/flightdeck', 'checks:aaronlilla/flightdeck#39']],
  };
}

describe('BlockersView', () => {
  it('shows the empty state when nothing is blocked', () => {
    render(<BlockersView blockers={[]} chains={[]} onResolve={vi.fn()} onCheck={vi.fn()} />);
    expect(screen.getByText('Nothing is blocked on you.')).toBeInTheDocument();
  });

  it('numbers a chain root-first and dims/disables the step after the first open one', () => {
    const { blockers, chains } = billingChain();
    render(<BlockersView blockers={blockers} chains={chains} onResolve={vi.fn()} onCheck={vi.fn()} />);
    expect(screen.getByText(/GitHub Actions billing is off/)).toBeInTheDocument();
    expect(screen.getByText(/Checks failing on PR #39/)).toBeInTheDocument();
    // Step 2's own Resolved button is disabled while step 1 is still open.
    const buttons = screen.getAllByRole('button', { name: /Resolved, check it/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).not.toBeDisabled();
    expect(buttons[1]).toBeDisabled();
  });

  it('shows Checking… then Resolved once a click confirms', async () => {
    const { blockers, chains } = billingChain();
    let resolveConfirm: (result: BlockersActionResult) => void = () => undefined;
    const onResolve = vi.fn(() => new Promise<BlockersActionResult>((resolve) => { resolveConfirm = resolve; }));
    render(<BlockersView blockers={blockers} chains={chains} onResolve={onResolve} onCheck={vi.fn()} />);
    const [firstButton] = screen.getAllByRole('button', { name: /Resolved, check it/ });
    await userEvent.click(firstButton!);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    resolveConfirm({ ok: true, state: 'resolved', lastCheck: 'confirmed', started: ['S-run1'] });
    await screen.findByText(/Started: the stale-session fix/);
  });

  it('shows Not yet with the reason when the confirmation fails', async () => {
    const { blockers, chains } = billingChain();
    const onResolve = vi.fn(async (): Promise<BlockersActionResult> => (
      { ok: false, state: 'open', lastCheck: 'still refused', started: [] }
    ));
    render(<BlockersView blockers={blockers} chains={chains} onResolve={onResolve} onCheck={vi.fn()} />);
    const [firstButton] = screen.getAllByRole('button', { name: /Resolved, check it/ });
    await userEvent.click(firstButton!);
    await screen.findByText('Not yet: still refused');
  });

  it('collapses a fully resolved chain into a one-line entry under Resolved today', () => {
    const resolved: Blocker = {
      id: 'billing:aaronlilla/flightdeck', kind: 'billing', title: 'GitHub Actions billing is off for aaronlilla/flightdeck',
      detail: '', youCanResolve: true, howToResolve: '', links: [], blocks: [], blockedBy: [],
      state: 'resolved', since: Date.now(), checkedAt: Date.now(), resolvedAt: Date.now(), thenWhat: '', lastCheck: 'confirmed',
    };
    render(<BlockersView blockers={[resolved]} chains={[]} onResolve={vi.fn()} onCheck={vi.fn()} />);
    expect(screen.getByText('Resolved today')).toBeInTheDocument();
    expect(screen.getByText(/GitHub Actions billing is off/)).toBeInTheDocument();
  });
});
