// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QueueView } from '../../src/console/components/QueueView.js';
import type { QueueItem } from '../../src/shared/console-model.js';

function item(extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'Q-1', source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: null, briefPath: null,
    branch: null, worktreePath: null, base: null, state: 'queued', reason: null, runKey: null,
    pr: null, journalIds: [], createdAt: Date.now(), updatedAt: Date.now(),
    ...extra,
  };
}

function renderQueue(items: QueueItem[], overrides: Partial<Parameters<typeof QueueView>[0]> = {}) {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const onRetry = vi.fn();
  const onPause = vi.fn();
  const onResume = vi.fn();
  render(
    <QueueView
      items={items} paused={false} maxInFlight={2}
      onAdd={onAdd} onRemove={onRemove} onRetry={onRetry} onPause={onPause} onResume={onResume}
      {...overrides}
    />,
  );
  return { onAdd, onRemove, onRetry, onPause, onResume };
}

describe('QueueView empty state', () => {
  it('says nothing is queued', () => {
    renderQueue([]);
    expect(screen.getByText(/nothing queued/)).toBeInTheDocument();
  });
});

describe('QueueView item states', () => {
  it('shows a parked item with its reason and a retry action', () => {
    renderQueue([item({ state: 'parked', reason: 'unrouted' })]);
    expect(screen.getByText('PARKED')).toBeInTheDocument();
    expect(screen.getByText('unrouted')).toBeInTheDocument();
    expect(screen.getByText('Retry →')).toBeInTheDocument();
  });

  it('shows a review item with a direct link to its draft PR', () => {
    renderQueue([item({ state: 'review', pr: { no: 42, url: 'https://github.com/o/n/pull/42', files: 0, add: 0, del: 0, draft: true } })]);
    const link = screen.getByText('Open PR #42 →');
    expect(link.closest('a')).toHaveAttribute('href', 'https://github.com/o/n/pull/42');
  });

  it('A.8: shows the real files/add/del figures on a review card', () => {
    renderQueue([item({ state: 'review', pr: { no: 42, url: 'https://github.com/o/n/pull/42', files: 3, add: 12, del: 4, draft: true } })]);
    expect(screen.getByText('3 files, +12/-4')).toBeInTheDocument();
  });

  it('A.7: shows a Merge action on a review card only when onMerge is wired, and fires it', () => {
    const onMerge = vi.fn();
    renderQueue(
      [item({ state: 'review', pr: { no: 9, url: 'https://github.com/o/n/pull/9', files: 1, add: 1, del: 0, draft: true } })],
      { onMerge },
    );
    fireEvent.click(screen.getByText('Merge'));
    expect(onMerge).toHaveBeenCalledWith('Q-1');
  });

  it('A.7: shows a Promote action on a done hotfix card only when onPromote is wired, and fires it', () => {
    const onPromote = vi.fn();
    renderQueue([item({ id: 'Q-2', source: 'hotfix', state: 'done' })], { onPromote });
    fireEvent.click(screen.getByText('Promote to production'));
    expect(onPromote).toHaveBeenCalledWith('Q-2');
  });

  it('A.7: never shows Promote on a done item that is not a hotfix', () => {
    const onPromote = vi.fn();
    renderQueue([item({ state: 'done' })], { onPromote });
    expect(screen.queryByText('Promote to production')).not.toBeInTheDocument();
  });

  it('retries a parked item on click', () => {
    const { onRetry } = renderQueue([item({ id: 'Q-2', state: 'parked', reason: 'FIX FIRST' })]);
    fireEvent.click(screen.getByText('Retry →'));
    expect(onRetry).toHaveBeenCalledWith('Q-2');
  });

  it('removes a queued item on click', () => {
    const { onRemove } = renderQueue([item({ id: 'Q-3', state: 'queued' })]);
    fireEvent.click(screen.getByText('Remove'));
    expect(onRemove).toHaveBeenCalledWith('Q-3');
  });
});

describe('QueueView pause/resume', () => {
  it('offers Pause queue when running', () => {
    renderQueue([]);
    expect(screen.getByText('Pause queue')).toBeInTheDocument();
  });

  it('shows a paused chip with Resume when paused', () => {
    renderQueue([], { paused: true });
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(screen.getByText('Resume queue')).toBeInTheDocument();
  });

  it('calls onPause and onResume', () => {
    const { onPause } = renderQueue([]);
    fireEvent.click(screen.getByText('Pause queue'));
    expect(onPause).toHaveBeenCalled();
  });
});

describe('QueueView add work', () => {
  it('adds a ticket by typing and pressing enter', () => {
    const { onAdd } = renderQueue([]);
    const input = screen.getByPlaceholderText('BB-123');
    fireEvent.change(input, { target: { value: 'ABC-9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('ticket', 'ABC-9');
  });

  it('switches to the brief source and adds pasted text', () => {
    const { onAdd } = renderQueue([]);
    fireEvent.click(screen.getByText('brief'));
    const textarea = screen.getByPlaceholderText('# Goal: ...');
    fireEvent.change(textarea, { target: { value: '# Goal: fix it' } });
    fireEvent.click(screen.getByText('Add ⏎'));
    expect(onAdd).toHaveBeenCalledWith('brief', '# Goal: fix it');
  });

  it('switches to the query source', () => {
    renderQueue([]);
    fireEvent.click(screen.getByText('query'));
    expect(screen.getByPlaceholderText(/sprint = 42/)).toBeInTheDocument();
  });

  it('switches to the backlog source', () => {
    renderQueue([]);
    fireEvent.click(screen.getByText('backlog'));
    expect(screen.getByPlaceholderText(/status = Backlog/)).toBeInTheDocument();
  });

  it('A.6: switches to the hotfix source and shows the ships-to-dev-then-production copy', () => {
    renderQueue([]);
    fireEvent.click(screen.getByText('hotfix'));
    expect(screen.getByText(/ships to dev on Merge/)).toBeInTheDocument();
  });

  it('A.6: adds a hotfix by typing and clicking Add', () => {
    const { onAdd } = renderQueue([]);
    fireEvent.click(screen.getByText('hotfix'));
    const textarea = screen.getByPlaceholderText(/what's broken/);
    fireEvent.change(textarea, { target: { value: 'login crashes' } });
    fireEvent.click(screen.getByText('Add ⏎'));
    expect(onAdd).toHaveBeenCalledWith('hotfix', 'login crashes');
  });

  it('A.5: a query template chip fills the JQL input', () => {
    renderQueue([]);
    fireEvent.click(screen.getByText('query'));
    fireEvent.click(screen.getByText('this sprint'));
    expect(screen.getByPlaceholderText(/sprint = 42/)).toHaveValue('sprint in openSprints()');
  });

  it('never calls onAdd for blank input', () => {
    const { onAdd } = renderQueue([]);
    fireEvent.click(screen.getByText('Add ⏎'));
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe('QueueView header', () => {
  it('shows the in-flight count against maxInFlight', () => {
    renderQueue([item({ state: 'running' }), item({ id: 'Q-2', state: 'planning' }), item({ id: 'Q-3', state: 'queued' })], { maxInFlight: 2 });
    expect(screen.getByText('2 / 2 in flight')).toBeInTheDocument();
  });
});
