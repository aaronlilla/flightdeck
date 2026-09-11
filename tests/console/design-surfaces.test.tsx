// @vitest-environment jsdom
/**
 * The design's surfaces (`doctrine/design/Flightdeck Console.dc.html`) render from real
 * data and every button reaches its route: the chrome's tabs and badges, the Board's
 * grid with idle slots and sections, the Needs-you question card, the Queue's stepper,
 * the Settings width and theme controls, the Flight review's Apply, and the lane sheet's
 * Answer and Send.
 */
import { act, fireEvent, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Chrome } from '../../src/console/components/Chrome.js';
import { FlightReview } from '../../src/console/components/FlightReview.js';
import { LanesGrid } from '../../src/console/components/LanesGrid.js';
import { NeedsYou, buildNeeds } from '../../src/console/components/NeedsYou.js';
import { QueueView } from '../../src/console/components/QueueView.js';
import { Settings } from '../../src/console/components/Settings.js';
import { TicketSheet } from '../../src/console/components/TicketSheet.js';
import { boardCta, idleReason } from '../../src/console/laneVM.js';
import type { Blocker, Feed, Lane, ProposalsResponse, QueueItem } from '../../src/shared/console-model.js';
import { render } from './helpers/with-store.js';

const mocks = vi.hoisted(() => ({
  postQueueWidth: vi.fn().mockResolvedValue({ ok: true, jid: null, message: 'queue width set to 3', undoable: false }),
  applyProposal: vi.fn().mockResolvedValue({ ok: true, jid: 'J-1', message: 'applied', undoable: true }),
  dismissProposal: vi.fn().mockResolvedValue({ ok: true, jid: 'J-2', message: 'dismissed', undoable: true }),
  checkIntegration: vi.fn().mockResolvedValue({ items: [], checkedAt: 0, everyS: 30 }),
  getRunSummary: vi.fn().mockResolvedValue({ what: ['Read the ticket.'], status: 'Waiting on you.', next: 'Answer the question below.', audit: null, readiness: null }),
  getRunStory: vi.fn().mockResolvedValue({ id: 'r1', title: null, kind: 'ticket', ticket: null, brief: null, entries: [{ at: 1, kind: 'ticket', text: 'started on ABC-1' }] }),
}));

vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return { ...actual, ...mocks };
});

const now = Date.now();
const feed: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: now };

function lane(extra: Partial<Lane> & { id: string }): Lane {
  return {
    title: 'A title', kind: 'ticket', sourceUrl: null, plain: 'Working on it.', mergeable: null, attempts: 1, retiredAt: null,
    ticket: extra.id, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement', repo: 'o/r', attempt: 1, state: 'running',
    reason: null, stepN: 1, stepTotal: 6, stepText: 'working', ctxTokens: 1, ctxCeiling: 2, ctxCompactAt: 2, tokens: 1, tokenCap: null,
    tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live', observedAt: now, verifiedAt: now, heart: true, since: now - 60_000, startedAt: now - 60_000,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    live: { alive: true, pid: 1, lastEventAt: now, checkedAt: now }, did: null, didVerbatim: false, now: 'Working on it.', you: null, ...extra,
  };
}

const queue = { items: [] as QueueItem[], paused: false, pauseReason: null, maxInFlight: 4, on: true };

describe('the chrome', () => {
  it('shows the six tabs in the design order, a badge only when the count is above zero, and the project', async () => {
    const onNav = vi.fn();
    render(<Chrome view="board" badges={{ blockers: 3 }} feed={feed} project={{ key: 'NWR', name: 'Northwind Rewards' }} now={now} onNav={onNav} />);
    const nav = screen.getByRole('navigation');
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Blockers3', 'Board', 'Queue', 'Review', 'Machine', 'Settings']);
    expect(screen.getByTestId('project-label')).toHaveTextContent('NWR · Northwind Rewards');
    await userEvent.click(screen.getByTestId('nav-queue'));
    expect(onNav).toHaveBeenCalledWith('queue');
  });
});

describe('the Board', () => {
  it('fills the width with idle cards that say why they are idle, and routes every button', async () => {
    const onCommand = vi.fn();
    const onOpen = vi.fn();
    const ready = lane({ id: 'ABC-2', state: 'done', pr: { no: 4, url: 'https://x/4', draft: false, merged: false, checks: 'success', verdict: 'PASS' }, mergeable: { ok: true } });
    const blocked = lane({ id: 'ABC-3', state: 'blocked', reason: 'gate: FIX FIRST' });
    render(<LanesGrid lanes={[lane({ id: 'ABC-1' }), ready, blocked]} blockers={[]} queue={queue} now={now} onOpen={onOpen} onCommand={onCommand} onLaneCommand={vi.fn()} onQueue={vi.fn()} />);
    expect(screen.getAllByTestId('idle-slot')).toHaveLength(1);
    expect(screen.getByTestId('idle-slot')).toHaveTextContent('Waiting for a Ready ticket; nothing is in the queue.');
    await userEvent.click(within(screen.getByTestId('lane-ABC-1')).getByTestId('primary-action'));
    expect(onCommand).toHaveBeenCalledWith('ABC-1', 'watch');
    await userEvent.click(within(screen.getByTestId('waiting-for-merge')).getByRole('button', { name: 'Merge' }));
    expect(onCommand).toHaveBeenCalledWith('ABC-2', 'merge');
    await userEvent.click(within(screen.getByTestId('blocked-or-parked')).getByRole('button', { name: 'Resume' }));
    expect(onCommand).toHaveBeenCalledWith('ABC-3', 'resume');
  });

  // R-75 item 3 (spec `doctrine/design/operator-experience.md` §5): the questions left
  // the Board. They are asked one at a time in the strip above the tabs, so this case
  // now renders the strip rather than the grid; the card contract it asserts is the
  // same one, through the same shared component.
  it('a lane that asked something renders the question card with its options and a typed answer', async () => {
    const onLaneCommand = vi.fn();
    const asked = lane({ id: 'ABC-5', state: 'parked', question: { key: 'k5', text: 'A or B?', opts: ['A', 'B'], askedAt: now - 120_000 } });
    const needs = buildNeeds([asked], [], now);
    render(<NeedsYou items={needs} now={now} onCommand={onLaneCommand} />);
    expect(screen.queryByTestId('needs-you')).toBeInTheDocument();
    const card = within(screen.getByTestId('needs-you')).getByTestId('question-card');
    await userEvent.click(within(card).getAllByTestId('question-option')[1]!);
    expect(onLaneCommand).toHaveBeenCalledWith('ABC-5', 'answer k5 B');
    await userEvent.type(within(card).getByTestId('question-freetext'), 'C, the third way{Enter}');
    expect(onLaneCommand).toHaveBeenCalledWith('ABC-5', 'answer k5 C, the third way');
  });

  it('a blocked lane offers the blocker\'s own way through', () => {
    const blocker: Blocker = { id: 'billing:o/r', kind: 'billing', title: 'Billing is off', detail: 'refused', youCanResolve: false, howToResolve: 'buy minutes', who: 'GitHub billing', links: [{ label: 'billing', url: 'https://billing' }], blocks: [{ laneId: 'ABC-3', label: 'ABC-3' }], blockedBy: [], state: 'open', since: now, checkedAt: null, resolvedAt: null, thenWhat: 'checks re-run', lastCheck: null };
    expect(boardCta(lane({ id: 'ABC-3', state: 'blocked' }), blocker)).toEqual({ label: 'Open billing', cmd: 'open-url:https://billing', kind: 'secondary' });
    expect(idleReason({ ...queue, paused: true, pauseReason: 'backoff' })).toContain('paused (backoff)');
  });
});

describe('the Queue and Settings steppers write the width', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.postQueueWidth.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the Queue stepper posts one more, once the clicking stops', async () => {
    render(<QueueView items={[]} paused={false} maxInFlight={4} working={1} />);
    fireEvent.click(within(screen.getByTestId('queue-width')).getByRole('button', { name: 'one more' }));
    expect(mocks.postQueueWidth).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.postQueueWidth).toHaveBeenCalledWith(5);
  });

  it('Settings posts one fewer, once the clicking stops, and flips the theme', async () => {
    const onTheme = vi.fn();
    render(<Settings integrations={[]} accounts={[]} caps={null} now={now} maxInFlight={4} theme="light" onTheme={onTheme} />);
    fireEvent.click(within(screen.getByTestId('settings-width')).getByRole('button', { name: 'one fewer' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.postQueueWidth).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByTestId('theme-dark'));
    expect(onTheme).toHaveBeenCalledWith('dark');
  });

  it('the displayed number moves at once, before any post goes out', () => {
    render(<QueueView items={[]} paused={false} maxInFlight={4} working={1} />);
    fireEvent.click(within(screen.getByTestId('queue-width')).getByRole('button', { name: 'one more' }));
    expect(within(screen.getByTestId('queue-width')).getByText('5')).toBeInTheDocument();
    expect(mocks.postQueueWidth).not.toHaveBeenCalled();
  });

  it('six to ten is one post of 10, not one per click', async () => {
    render(<QueueView items={[]} paused={false} maxInFlight={6} working={1} />);
    const more = within(screen.getByTestId('queue-width')).getByRole('button', { name: 'one more' });
    fireEvent.click(more);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    fireEvent.click(more);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    fireEvent.click(more);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    fireEvent.click(more);
    expect(within(screen.getByTestId('queue-width')).getByText('10')).toBeInTheDocument();
    expect(mocks.postQueueWidth).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.postQueueWidth).toHaveBeenCalledTimes(1);
    expect(mocks.postQueueWidth).toHaveBeenCalledWith(10);
  });

  it('a rejected post snaps the display back to the server value', async () => {
    mocks.postQueueWidth.mockResolvedValueOnce({ ok: false, jid: null, message: 'width refused', undoable: false });
    render(<QueueView items={[]} paused={false} maxInFlight={4} working={1} />);
    const more = within(screen.getByTestId('queue-width')).getByRole('button', { name: 'one more' });
    fireEvent.click(more);
    expect(within(screen.getByTestId('queue-width')).getByText('5')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(within(screen.getByTestId('queue-width')).getByText('4')).toBeInTheDocument();
  });

  it('a debounce that fires mid-flight is queued and resent once the call settles, never dropped', async () => {
    let resolveFirst!: (value: { ok: boolean; jid: string | null; message: string; undoable: boolean }) => void;
    const first = new Promise<{ ok: boolean; jid: string | null; message: string; undoable: boolean }>((resolve) => { resolveFirst = resolve; });
    mocks.postQueueWidth.mockImplementationOnce(() => first);
    render(<QueueView items={[]} paused={false} maxInFlight={4} working={1} />);
    const more = within(screen.getByTestId('queue-width')).getByRole('button', { name: 'one more' });
    fireEvent.click(more);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.postQueueWidth).toHaveBeenCalledTimes(1);
    expect(mocks.postQueueWidth).toHaveBeenCalledWith(5);
    // A second click's debounce fires while the first post is still in flight --
    // `useAction.run` would drop it silently; the hook must hold it instead.
    fireEvent.click(more);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.postQueueWidth).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst({ ok: true, jid: null, message: 'queue width set to 5', undoable: false });
      await Promise.resolve();
    });
    expect(mocks.postQueueWidth).toHaveBeenCalledTimes(2);
    expect(mocks.postQueueWidth).toHaveBeenLastCalledWith(6);
  });

  it('a width another actor set is picked up when the user is not mid-edit', () => {
    const { rerender } = render(<QueueView items={[]} paused={false} maxInFlight={4} working={1} />);
    expect(within(screen.getByTestId('queue-width')).getByText('4')).toBeInTheDocument();
    rerender(<QueueView items={[]} paused={false} maxInFlight={10} working={1} />);
    expect(within(screen.getByTestId('queue-width')).getByText('10')).toBeInTheDocument();
    expect(mocks.postQueueWidth).not.toHaveBeenCalled();
  });
});

describe('the Flight review', () => {
  it('draws six tiles off the metrics and applies the top proposal', async () => {
    const proposals: ProposalsResponse = {
      rules: [{ id: 'r1', kind: 'cost', title: 'Kill after 3 fails', summary: 'saves tokens', evidence: '', effect: '', status: 'open', jid: null, prUrl: null }],
      metrics: { mergedToday: 2, humanWaitMin: 8, tokensPerMerge: 1000, tokensWasted: 0, ticketsIn: 5, handedToQa: 3, blockersCleared: 1, slowestHop: { name: 'Waiting for your answers', minutes: 47 } },
      computedAt: now,
    };
    render(<FlightReview proposals={proposals} now={now} tokensToday={1_000_000} dailyTokens={2_000_000} />);
    expect(screen.getAllByTestId('metric')).toHaveLength(6);
    expect(screen.getAllByTestId('metric')[5]).toHaveTextContent('47 min');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(mocks.applyProposal).toHaveBeenCalledWith('r1');
  });
});

describe('the lane sheet', () => {
  it('reads the summary, answers the question, and sends a note as two separate controls', async () => {
    const onCommand = vi.fn();
    const onSendLane = vi.fn();
    const asked = lane({ id: 'ABC-7', state: 'parked', question: { key: 'k7', text: 'A or B?', opts: ['A', 'B'], askedAt: now } });
    render(<TicketSheet lane={asked} now={now} onClose={vi.fn()} onCommand={onCommand} onSendLane={onSendLane} />);
    await waitFor(() => expect(screen.getByText('Read the ticket.')).toBeInTheDocument());
    await userEvent.click(screen.getAllByTestId('question-option')[0]!);
    expect(onCommand).toHaveBeenCalledWith('ABC-7', 'answer k7 A');
    await userEvent.type(screen.getByTestId('sheet-note'), 'Use the existing client{Enter}');
    expect(onSendLane).toHaveBeenCalledWith('ABC-7', 'Use the existing client');
  });
});
