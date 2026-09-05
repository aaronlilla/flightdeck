// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InboxCard } from '../../src/console/components/InboxCard.js';
import { openQuestion } from '../../src/console/fixtures/inbox.js';
import type { InboxEntry } from '../../src/console/types.js';

afterEach(() => {
  cleanup();
});

/**
 * F3: an ask whose every run is dead has nothing left for an answer to reach. The
 * console has to stop offering Yes/No/free-text controls for it and offer a Clear
 * instead, or a person answers and nothing happens.
 */
describe('InboxCard: a stale ask', () => {
  const staleEntry: InboxEntry = {
    ...openQuestion,
    stale: true,
    staleReason: 'every run that asked this (forge-live-probe) is gone; answering resumes nothing',
  };

  it('shows the reason and a Clear button instead of the answer controls', () => {
    render(<InboxCard entry={staleEntry} onAnswer={vi.fn()} onClear={vi.fn()} />);

    expect(screen.getByText(staleEntry.staleReason!)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'dev' })).toBeNull();
    expect(screen.queryByPlaceholderText('Answer in your own words')).toBeNull();
  });

  it('calls onClear with the entry key when Clear is pressed', async () => {
    const onClear = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<InboxCard entry={staleEntry} onAnswer={vi.fn()} onClear={onClear} />);

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onClear).toHaveBeenCalledWith(staleEntry.key);
  });

  it('a live ask still shows its answer controls, unaffected', () => {
    render(<InboxCard entry={openQuestion} onAnswer={vi.fn()} onClear={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'dev' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});
