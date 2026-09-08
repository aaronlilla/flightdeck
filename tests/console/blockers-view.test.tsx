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

describe('BlockersView links (iteration 6, no Linkify.tsx in this worktree)', () => {
  it('links a PR # token in the title and detail when the blocker\'s own links name it', () => {
    const lane = { laneId: 'S-run1', label: 'the stale-session fix' };
    const now = Date.now();
    const checks: Blocker = {
      id: 'checks:o/n#39', kind: 'checks', title: 'Checks failing on PR #39 (o/n)',
      detail: 'PR #39 on o/n has failing checks.', youCanResolve: true, howToResolve: 'Fix and push.',
      links: [{ label: 'PR #39', url: 'https://github.com/o/n/pull/39' }], blocks: [lane], blockedBy: [],
      state: 'open', since: now, checkedAt: null, resolvedAt: null, thenWhat: 'Resumes the stale-session fix.', lastCheck: null,
    };
    render(<BlockersView blockers={[checks]} chains={[[checks.id]]} onResolve={vi.fn()} onCheck={vi.fn()} />);
    const links = screen.getAllByRole('link', { name: 'PR #39' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'https://github.com/o/n/pull/39');
      expect(link).toHaveAttribute('target', '_blank');
    }
  });

  it('links a bare BBZ- key through jiraSite when nothing in links names it', () => {
    const question: Blocker = {
      id: 'question:abc123', kind: 'question', title: 'BBZ-42: which environment?',
      detail: 'BBZ-42 needs an environment pick.', youCanResolve: true, howToResolve: 'Answer it.',
      links: [], blocks: [], blockedBy: [], state: 'open', since: Date.now(), checkedAt: null,
      resolvedAt: null, thenWhat: 'Resumes once answered.', lastCheck: null,
    };
    render(
      <BlockersView
        blockers={[question]} chains={[[question.id]]} onResolve={vi.fn()} onCheck={vi.fn()}
        jiraSite="https://boltbetz-bankroll-dev.atlassian.net"
      />,
    );
    const links = screen.getAllByRole('link', { name: 'BBZ-42' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'https://boltbetz-bankroll-dev.atlassian.net/browse/BBZ-42');
    }
  });

  it('links a lane label named "Blocks:" through the blocker\'s own links', () => {
    const checks: Blocker = {
      id: 'checks:o/n#39', kind: 'checks', title: 'Checks failing on PR #39', detail: 'd', youCanResolve: true,
      howToResolve: 'h', links: [{ label: 'PR #39', url: 'https://github.com/o/n/pull/39' }],
      blocks: [{ laneId: 'S-run1', label: 'PR #39' }], blockedBy: [], state: 'open', since: Date.now(),
      checkedAt: null, resolvedAt: null, thenWhat: 't', lastCheck: null,
    };
    render(<BlockersView blockers={[checks]} chains={[[checks.id]]} onResolve={vi.fn()} onCheck={vi.fn()} />);
    const links = screen.getAllByRole('link', { name: 'PR #39' });
    expect(links.length).toBeGreaterThan(1);
  });
});
