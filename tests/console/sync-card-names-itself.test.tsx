// @vitest-environment jsdom
/**
 * A sync card says what it covers.
 *
 * Every card showed its state and never its subject, so each one read "never synced" with
 * nothing saying what had never synced. The machine screen carries two of them, and the
 * same sentence rendered twice, one above the other, with no way to tell which was the
 * machine and which the sessions (measured on the live console, 2026-09-12).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SyncCard } from '../../src/console/components/SyncCard.js';
import { SYNC_SCOPE_NAME, syncScopeName } from '../../src/console/sync-text.js';

describe('what a sync card says it covers', () => {
  it('names its scope beside the state, never the state alone', () => {
    render(<SyncCard scope="machine" run={null} busy={false} onResync={() => {}} />);
    expect(screen.getByTestId('sync-scope').textContent).toBe('This machine');
    // The state stays in its own element, so a reader of that element still gets the
    // state alone -- the label is beside it, not inside it.
    expect(screen.getByTestId('sync-summary').textContent).toBe('never synced');
  });

  it('tells the machine screen\'s two cards apart', () => {
    render(
      <>
        <SyncCard scope="machine" run={null} busy={false} onResync={() => {}} />
        <SyncCard scope="sessions" run={null} busy={false} onResync={() => {}} />
      </>,
    );
    const names = screen.getAllByTestId('sync-scope').map((el) => el.textContent);
    expect(names).toEqual(['This machine', 'Sessions']);
    expect(new Set(names).size, 'two cards read the same').toBe(2);
  });

  it('names every scope a card is rendered for', () => {
    // The list the page actually renders. A scope added to the page and not to the table
    // falls through to its own key, which is ugly but never blank.
    for (const scope of ['lanes', 'inbox', 'queue', 'machine', 'sessions', 'accounts']) {
      expect(SYNC_SCOPE_NAME[scope], `${scope} has no name`).toBeTruthy();
    }
  });

  it('never answers blank, even for a scope nobody named', () => {
    expect(syncScopeName('somethingNew')).toBe('somethingNew');
  });
});
