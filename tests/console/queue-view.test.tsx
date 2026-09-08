// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueueView } from '../../src/console/components/QueueView.js';
import type { QueueItem } from '../../src/shared/console-model.js';
import type { ActionResult } from '../../src/shared/console-model.js';
import { render } from './helpers/with-store.js';

// Every mutating control now goes straight through `api.ts` (no more parent
// callback props), so the catalog's own effect is what a test can observe.
// `importOriginal` keeps `ApiError` / `isConfirmPending` / everything else real --
// only the functions this file exercises are replaced.
vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return {
    ...actual,
    mergeQueueItem: vi.fn(),
    removeQueueItem: vi.fn(),
    retryQueueItem: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    addToQueue: vi.fn(),
    promoteQueueItem: vi.fn(),
  };
});

import * as api from '../../src/console/api.js';

function ok(overrides: Partial<ActionResult> = {}): ActionResult {
  return { ok: true, jid: null, message: 'done', undoable: false, ...overrides };
}

function confirmPending(token = 'tok-1', blast = 'this cannot be undone') {
  return {
    ok: false as const,
    pending: true as const,
    token,
    blast,
    card: { k: 'card-1', type: 'system', text: blast, ts: Date.now(), source: 'console' },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

function item(extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'Q-1', source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: null, briefPath: null,
    branch: null, worktreePath: null, base: null, state: 'queued', reason: null, runKey: null,
    pr: null, journalIds: [], createdAt: Date.now(), updatedAt: Date.now(),
    ...extra,
  };
}

function renderQueue(items: QueueItem[], overrides: Partial<Parameters<typeof QueueView>[0]> = {}) {
  const onToast = vi.fn();
  const view = render(<QueueView items={items} paused={false} maxInFlight={2} onToast={onToast} {...overrides} />);
  return { onToast, ...view };
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

  it('A.7: a Merge click on a review card asks first -- the server-issued confirm card, not a local dialog', async () => {
    // Sweep #5: the board's own Merge asks first; a queue card's Merge must too. The
    // "asking" is no longer a client-side dialog -- it is the server's 202 pending
    // response, rendered by ActionOutcomeView as a confirm card.
    (api.mergeQueueItem as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(confirmPending('tok-merge', 'merge Q-1 into develop'))
      .mockResolvedValueOnce(ok({ message: 'merged' }));
    renderQueue([item({ state: 'review', pr: { no: 9, url: 'https://github.com/o/n/pull/9', files: 1, add: 1, del: 0, draft: true } })]);

    fireEvent.click(screen.getByTestId('action-mergeQueueItem-Q-1'));
    expect(await screen.findByTestId('action-confirm-mergeQueueItem-Q-1')).toBeInTheDocument();
    expect(api.mergeQueueItem).toHaveBeenCalledTimes(1);
    expect(api.mergeQueueItem).toHaveBeenCalledWith('Q-1', undefined);

    fireEvent.click(screen.getByTestId('action-confirm-yes-mergeQueueItem-Q-1'));
    await screen.findByTestId('action-result-mergeQueueItem-Q-1');
    expect(api.mergeQueueItem).toHaveBeenCalledTimes(2);
    expect(api.mergeQueueItem).toHaveBeenNthCalledWith(2, 'Q-1', 'tok-merge');
  });

  it('A.7: dismissing the merge confirm card never issues a second call', async () => {
    (api.mergeQueueItem as ReturnType<typeof vi.fn>).mockResolvedValueOnce(confirmPending('tok-merge'));
    renderQueue([item({ state: 'review', pr: { no: 9, url: 'https://github.com/o/n/pull/9', files: 1, add: 1, del: 0, draft: true } })]);

    fireEvent.click(screen.getByTestId('action-mergeQueueItem-Q-1'));
    await screen.findByTestId('action-confirm-mergeQueueItem-Q-1');
    fireEvent.click(screen.getByTestId('action-confirm-no-mergeQueueItem-Q-1'));

    expect(api.mergeQueueItem).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('action-mergeQueueItem-Q-1')).toBeInTheDocument();
    expect(screen.queryByTestId('action-confirm-mergeQueueItem-Q-1')).not.toBeInTheDocument();
  });

  it('A.7: a Promote click on a done hotfix card collects a version and message before it can fire', async () => {
    (api.promoteQueueItem as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(confirmPending('tok-promote', 'promote Q-2 to production'))
      .mockResolvedValueOnce(ok({ message: 'promoted' }));
    renderQueue([item({ id: 'Q-2', source: 'hotfix', state: 'done' })]);

    fireEvent.click(screen.getByText('Promote'));
    const submit = screen.getByTestId('action-promoteQueueItem-Q-2');

    // Sweep #4: the real server always required {version, message}; the control stays
    // blocked (aria-disabled) with nothing typed, so nothing is ever sent empty.
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(submit);
    expect(api.promoteQueueItem).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/version/i), { target: { value: '1.4.2' } });
    fireEvent.change(screen.getByPlaceholderText(/release message/i), { target: { value: 'hotfix release' } });
    expect(submit).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(submit);
    expect(api.promoteQueueItem).toHaveBeenCalledWith('Q-2', '1.4.2', 'hotfix release', undefined);

    await screen.findByTestId('action-confirm-promoteQueueItem-Q-2');
    fireEvent.click(screen.getByTestId('action-confirm-yes-promoteQueueItem-Q-2'));
    await screen.findByTestId('action-result-promoteQueueItem-Q-2');
    expect(api.promoteQueueItem).toHaveBeenNthCalledWith(2, 'Q-2', '1.4.2', 'hotfix release', 'tok-promote');
  });

  it('A.7: a promoted item shows its version instead of the Promote button', () => {
    renderQueue([item({ id: 'Q-2', source: 'hotfix', state: 'done', promotedAt: Date.now(), promotedVersion: '1.4.2' })]);
    expect(screen.getByText('promoted 1.4.2')).toBeInTheDocument();
    expect(screen.queryByText('Promote')).not.toBeInTheDocument();
  });

  it('A.7: never shows Promote on a done item that is not a hotfix', () => {
    renderQueue([item({ state: 'done' })]);
    expect(screen.queryByText('Promote')).not.toBeInTheDocument();
  });

  it('retries a parked item on click', async () => {
    (api.retryQueueItem as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ message: 're-queued' }));
    renderQueue([item({ id: 'Q-2', state: 'parked', reason: 'FIX FIRST' })]);
    fireEvent.click(screen.getByText('Retry →'));
    await screen.findByTestId('action-result-retryQueueItem-Q-2');
    expect(api.retryQueueItem).toHaveBeenCalledWith('Q-2');
  });

  it('removes a queued item on click', async () => {
    (api.removeQueueItem as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(confirmPending('tok-remove'))
      .mockResolvedValueOnce(ok({ message: 'removed' }));
    renderQueue([item({ id: 'Q-3', state: 'queued' })]);
    fireEvent.click(screen.getByTestId('action-removeQueueItem-Q-3'));
    await screen.findByTestId('action-confirm-removeQueueItem-Q-3');
    expect(api.removeQueueItem).toHaveBeenCalledWith('Q-3', undefined);

    fireEvent.click(screen.getByTestId('action-confirm-yes-removeQueueItem-Q-3'));
    await screen.findByTestId('action-result-removeQueueItem-Q-3');
    expect(api.removeQueueItem).toHaveBeenNthCalledWith(2, 'Q-3', 'tok-remove');
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

  it('calls onPause and onResume', async () => {
    (api.pauseQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ message: 'paused' }));
    (api.resumeQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({ message: 'resumed' }));

    const { unmount } = renderQueue([]);
    fireEvent.click(screen.getByText('Pause queue'));
    await screen.findByTestId('action-result-pauseQueue-queue');
    expect(api.pauseQueue).toHaveBeenCalled();
    unmount();

    renderQueue([], { paused: true });
    fireEvent.click(screen.getByText('Resume queue'));
    await screen.findByTestId('action-result-resumeQueue-queue');
    expect(api.resumeQueue).toHaveBeenCalled();
  });
});

describe('QueueView add work', () => {
  it('adds a ticket by typing and pressing enter', async () => {
    (api.addToQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, items: [item({ id: 'Q-9' })] });
    renderQueue([]);
    const input = screen.getByPlaceholderText('BB-123');
    fireEvent.change(input, { target: { value: 'ABC-9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByTestId('action-result-addToQueue-add-work');
    expect(api.addToQueue).toHaveBeenCalledWith({ source: 'ticket', input: 'ABC-9' });
  });

  it('switches to the brief source and adds pasted text', async () => {
    (api.addToQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, items: [item({ id: 'Q-9', source: 'brief' })] });
    renderQueue([]);
    fireEvent.click(screen.getByText('brief'));
    const textarea = screen.getByPlaceholderText(/^# Goal: .../);
    fireEvent.change(textarea, { target: { value: '# Goal: fix it' } });
    fireEvent.click(screen.getByText('Add ⏎'));
    await screen.findByTestId('action-result-addToQueue-add-work');
    expect(api.addToQueue).toHaveBeenCalledWith({ source: 'brief', input: '# Goal: fix it' });
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

  it('A.6: adds a hotfix by typing and clicking Add', async () => {
    (api.addToQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, items: [item({ id: 'Q-9', source: 'hotfix' })] });
    renderQueue([]);
    fireEvent.click(screen.getByText('hotfix'));
    const textarea = screen.getByPlaceholderText(/what's broken/);
    fireEvent.change(textarea, { target: { value: 'login crashes' } });
    fireEvent.click(screen.getByText('Add ⏎'));
    await screen.findByTestId('action-result-addToQueue-add-work');
    expect(api.addToQueue).toHaveBeenCalledWith({ source: 'hotfix', input: 'login crashes' });
  });

  it('A.5: a query template chip fills the JQL input', () => {
    renderQueue([]);
    fireEvent.click(screen.getByText('query'));
    fireEvent.click(screen.getByText('this sprint'));
    expect(screen.getByPlaceholderText(/sprint = 42/)).toHaveValue('sprint in openSprints()');
  });

  it('never calls addToQueue for blank input', () => {
    renderQueue([]);
    fireEvent.click(screen.getByText('Add ⏎'));
    expect(api.addToQueue).not.toHaveBeenCalled();
  });
});

describe('QueueView header', () => {
  it('shows the in-flight count against maxInFlight', () => {
    renderQueue([item({ state: 'running' }), item({ id: 'Q-2', state: 'planning' }), item({ id: 'Q-3', state: 'queued' })], { maxInFlight: 2 });
    expect(screen.getByText('2 / 2 in flight')).toBeInTheDocument();
  });

  // Sweep #18: the nav badge counts parked+failed while this header counted every
  // item, so "Queue 8" and "Queue · 28 items" read as two disagreeing numbers.
  it('names the needs-attention subset alongside the total item count', () => {
    renderQueue([
      item({ id: 'Q-1', state: 'queued' }),
      item({ id: 'Q-2', state: 'parked' }),
      item({ id: 'Q-3', state: 'failed' }),
    ]);
    expect(screen.getByText('Queue · 3 items, 2 need attention')).toBeInTheDocument();
  });

  it('omits the needs-attention clause entirely when nothing is parked or failed', () => {
    renderQueue([item({ id: 'Q-1', state: 'queued' })]);
    expect(screen.getByText('Queue · 1 item')).toBeInTheDocument();
  });
});
