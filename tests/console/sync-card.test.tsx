// @vitest-environment jsdom
/**
 * The per-page sync card (R-71): renders `runSummary` and one row per stage from the
 * fixture alone, never a hardcoded count or string.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SyncCard } from '../../src/console/components/SyncCard.js';
import type { SyncRunRecord } from '../../src/shared/sync-contract.js';

const okRun: SyncRunRecord = {
  scope: 'lanes', id: 'r-ok', startedAt: 1000, endedAt: 9000, ok: true,
  stages: [
    { name: 'fetch-repos', status: 'ok', startedAt: 1000, endedAt: 2000, counts: { fetched: 3 } },
    { name: 'reconcile-prs', status: 'ok', startedAt: 2000, endedAt: 3000, counts: { shipped: 2, open: 1 } },
    { name: 'sweep-worktrees', status: 'ok', startedAt: 3000, endedAt: 4000, counts: { removed: 1, kept: 4 } },
    { name: 'pull-jira', status: 'ok', startedAt: 4000, endedAt: 5000, counts: { pulled: 6 } },
    { name: 'watcher-on', status: 'ok', startedAt: 5000, endedAt: 6000, counts: {} },
    { name: 'stop-workers', status: 'ok', startedAt: 6000, endedAt: 7000, counts: { stopped: 2 } },
    { name: 'wipe-queue', status: 'ok', startedAt: 7000, endedAt: 7500, counts: { wiped: 14 } },
    { name: 'reset-watermarks', status: 'ok', startedAt: 7500, endedAt: 8000, counts: {} },
    { name: 'resume', status: 'ok', startedAt: 8000, endedAt: 9000, counts: {} },
  ],
};

const failedRun: SyncRunRecord = {
  scope: 'queue', id: 'r-failed', startedAt: 1000, endedAt: 4000, ok: false,
  stages: [
    { name: 'fetch-repos', status: 'ok', startedAt: 1000, endedAt: 2000, counts: { fetched: 3 } },
    { name: 'reconcile-prs', status: 'failed', startedAt: 2000, endedAt: 3000, counts: {}, message: 'gh: rate limited' },
    { name: 'sweep-worktrees', status: 'skipped', startedAt: 3000, counts: {} },
    { name: 'pull-jira', status: 'skipped', startedAt: 3000, counts: {} },
  ],
};

describe('SyncCard', () => {
  it('renders the nine-stage ok run', () => {
    render(<SyncCard scope="lanes" run={okRun} busy={false} onResync={vi.fn()} />);
    expect(screen.getByTestId('sync-summary').textContent).toBe('synced ok · 9 stages');
    expect(screen.getAllByTestId(/^sync-stage-/)).toHaveLength(9);
  });

  it('renders the failed run with the failed stage message visible and the skipped tail', () => {
    render(<SyncCard scope="queue" run={failedRun} busy={false} onResync={vi.fn()} />);
    expect(screen.getByTestId('sync-summary').textContent).toBe('failed at reconcile-prs · gh: rate limited');
    expect(screen.getByTestId('sync-stage-reconcile-prs').textContent).toContain('gh: rate limited');
    expect(screen.getByTestId('sync-stage-sweep-worktrees').textContent).toBe('sweep-worktrees · skipped');
  });

  it('calls onResync with the card\'s own scope', () => {
    const onResync = vi.fn();
    render(<SyncCard scope="machine" run={null} busy={false} onResync={onResync} />);
    fireEvent.click(screen.getByTestId('sync-resync'));
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenCalledWith('machine');
  });

  it('disables Re-sync while busy', () => {
    render(<SyncCard scope="inbox" run={null} busy onResync={vi.fn()} />);
    expect((screen.getByTestId('sync-resync') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders never synced for a null run', () => {
    render(<SyncCard scope="accounts" run={null} busy={false} onResync={vi.fn()} />);
    expect(screen.getByTestId('sync-summary').textContent).toBe('never synced');
  });
});
