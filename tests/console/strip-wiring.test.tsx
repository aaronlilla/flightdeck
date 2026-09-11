// @vitest-environment jsdom
/**
 * R-75, the three blocking findings from the 2026-09-11 review of this branch. Each one
 * is a gap between what the strip's own tests proved and what the page actually wires to
 * it, so these mount the whole page and go through its real command path rather than a
 * function the strip is handed by a test.
 *
 * 1. The passed state was client-only: the page's command handler returned nothing and
 *    swallowed refusals, so the rollback the strip's own tests exercise through an
 *    injected rejecting function could never run in the app.
 * 2. Blocker cards never cleared, so blockers the fleet had long since resolved ranked
 *    ahead of every real question and the counter overstated the work.
 * 3. A strip option that navigates ("Open Blockers and clear it") was posted to the
 *    grammar instead of navigating, refused, and the strip advanced past it anyway.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Blocker, Lane, Message } from '../../src/shared/console-model.js';

const now = Date.now();

const state = vi.hoisted(() => ({
  lanes: [] as unknown[],
  blockers: [] as unknown[],
  thread: [] as unknown[],
  cards: [] as unknown[],
}));

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }));

vi.mock('../../src/console/api.js', () => ({
  getLanes: vi.fn(async () => ({ at: Date.now(), lanes: state.lanes, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } })),
  getThread: vi.fn(async () => ({ messages: state.thread, cards: state.cards })),
  getIntegrations: vi.fn(async () => ({ items: [] })),
  getCaps: vi.fn(async () => ({ dailyTokens: 0, tokensToday: 0, runTokens: 0 })),
  getProposals: vi.fn(async () => ({ rules: [], metrics: {}, computedAt: Date.now() })),
  getQueue: vi.fn(async () => ({ items: [], paused: false, maxInFlight: 4 })),
  getState: vi.fn(async () => ({ queue_on: true, build: 'test', project: null })),
  getBlockers: vi.fn(async () => ({ blockers: state.blockers, chains: [] })),
  getAccounts: vi.fn(async () => ({ items: [] })),
  getMachine: vi.fn(async () => ({ glance: '', readAt: Date.now(), intervalMs: 5000, sessions: [], unregistered: [] })),
  getSync: vi.fn(async () => ({
    runs: { full: null, queue: null, sessions: null, accounts: null, machine: null, inbox: null, lanes: null },
    watcher: { on: false, project: null, pollSeconds: 30 },
  })),
  ApiError: class ApiError extends Error {},
  isConfirmPending: (v: unknown) => typeof v === 'object' && v !== null && (v as { pending?: unknown }).pending === true,
  sendCommand: mocks.sendCommand,
  getLeftovers: vi.fn(async () => ({ items: [] })),
  connectAccount: vi.fn(),
  getConnectAttempt: vi.fn(),
  disconnectAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteLeftover: vi.fn(),
}));

import { App } from '../../src/console/App.js';
import { buildNeeds } from '../../src/console/components/NeedsYou.js';

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { setTimeout(() => this.onopen?.(), 0); }
  close(): void { /* nothing to tear down */ }
}

function lane(extra: Partial<Lane> & { id: string }): Lane {
  return {
    title: 'A title', kind: 'ticket', sourceUrl: null, plain: 'Working on it.', mergeable: null, attempts: 1, retiredAt: null,
    ticket: extra.id, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement', repo: 'o/r', attempt: 1, state: 'running',
    reason: null, stepN: 1, stepTotal: 6, stepText: 'working', ctxTokens: 1, ctxCeiling: 2, ctxCompactAt: 2, tokens: 1, tokenCap: null,
    tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live', observedAt: now, verifiedAt: now, heart: true, since: now - 60_000, startedAt: now - 60_000,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    live: { alive: true, pid: 1, lastEventAt: now, checkedAt: now }, did: null, didVerbatim: false, now: 'Working on it.', you: null, ...extra,
  } as Lane;
}

function blockerCard(k: string, laneId: string, what: string, ts: number): Message {
  return {
    k, type: 'blocker', text: what, ts, source: laneId, lane: laneId,
    kicker: `Blocked · ${laneId}`, title: what, body: 'The agent is parked until it clears.',
    btns: [{ label: 'Open Blockers and clear it', cmd: 'open blockers', cls: 'answer' }],
  };
}

function blocker(id: string, laneId: string, blockerState: Blocker['state']): Blocker {
  return {
    id, kind: 'integration', title: 'Sentry token', detail: 'expired', youCanResolve: true,
    howToResolve: 'rotate it', who: 'Sentry', links: [], blocks: [{ laneId, label: laneId }], blockedBy: [],
    state: blockerState, since: now - 60_000, checkedAt: null, resolvedAt: blockerState === 'resolved' ? now - 1_000 : null,
    thenWhat: 'the lane resumes', lastCheck: null,
  } as Blocker;
}

describe('a resolved blocker leaves the strip (blocking finding 2)', () => {
  it('drops a blocker card whose blocker the fleet has resolved', () => {
    const cards = [blockerCard('blk-old', 'FLT-500', 'Sentry is unreachable', now - 600_000)];
    const lanes = [lane({ id: 'FLT-501', question: { key: 'ask-1', text: 'Which base?', opts: ['main', 'develop'], askedAt: now - 1_000, recommended: 0, optionSource: 'worker' } })];

    expect(buildNeeds(lanes, cards, [blocker('b1', 'FLT-500', 'resolved')]).map((n) => n.kind)).toEqual(['lane']);
    expect(buildNeeds(lanes, cards, [blocker('b1', 'FLT-500', 'open')]).map((n) => n.kind)).toEqual(['blocker', 'lane']);
  });

  it('keeps every blocker card when the fleet has not said which are open', () => {
    const cards = [blockerCard('blk-old', 'FLT-500', 'Sentry is unreachable', now - 600_000)];
    // The blockers slice has not loaded: a card is not dropped on a guess.
    expect(buildNeeds([], cards).map((n) => n.kind)).toEqual(['blocker']);
  });

  it('drops a blocker card that no blocker in the list claims at all', () => {
    const cards = [blockerCard('blk-ghost', 'FLT-777', 'a blocker nobody is tracking', now - 600_000)];
    expect(buildNeeds([], cards, [blocker('b1', 'FLT-500', 'open')]).map((n) => n.kind)).toEqual([]);
  });
});

describe('the page wires the strip to a real command path (blocking findings 1 and 3)', () => {
  beforeEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
    state.lanes = []; state.blockers = []; state.thread = []; state.cards = [];
    mocks.sendCommand.mockReset();
    mocks.sendCommand.mockResolvedValue({ cards: [] });
  });
  afterEach(() => { mocks.sendCommand.mockReset(); });

  it('an option that navigates changes the view instead of being posted', async () => {
    state.blockers = [blocker('b1', 'FLT-500', 'open')];
    state.cards = [blockerCard('blk-1', 'FLT-500', 'Sentry is unreachable', now - 1_000)];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('needs-you')).toBeInTheDocument());
    mocks.sendCommand.mockClear();
    await userEvent.click(within(screen.getByTestId('needs-you')).getAllByTestId('question-option')[0]!);
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('nav-blockers')).toHaveAttribute('aria-current', 'page'));
  });

  it('a refused Pass to… rolls the card back, through the page\'s own command path', async () => {
    state.lanes = [lane({ id: 'FLT-510', question: { key: 'ask-p', text: 'Keep the column?', opts: ['Keep it', 'Drop it'], askedAt: now, recommended: 0, optionSource: 'worker' } })];
    mocks.sendCommand.mockResolvedValue({
      cards: [{ k: 'r1', type: 'refusal', text: 'I did not understand that', ts: Date.now(), source: 'conductor' }],
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('question-pass')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('question-pass'));
    await userEvent.click(screen.getByText('Joe'));

    expect(mocks.sendCommand).toHaveBeenCalledWith('pass ask-p Joe', undefined);
    await waitFor(() => expect(screen.getByTestId('question-pass-error')).toBeInTheDocument());
    expect(screen.getByTestId('question-pass-error')).toHaveTextContent('I did not understand that');
    expect(screen.getByTestId('question-pass-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('question-passed')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('question-option')).toHaveLength(2);
  });

  it('an accepted Pass to… keeps the passed line, through the same path', async () => {
    state.lanes = [lane({ id: 'FLT-511', question: { key: 'ask-q', text: 'Keep the column?', opts: ['Keep it', 'Drop it'], askedAt: now, recommended: 0, optionSource: 'worker' } })];
    mocks.sendCommand.mockResolvedValue({
      cards: [{ k: 'r1', type: 'receipt', text: 'passed to Joe', ts: Date.now(), source: 'conductor' }],
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('question-pass')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('question-pass'));
    await userEvent.click(screen.getByText('Joe'));
    await waitFor(() => expect(screen.getByTestId('question-passed')).toHaveAttribute('data-pending', 'false'));
    expect(screen.queryByTestId('question-pass-error')).not.toBeInTheDocument();
  });
});

describe('a blocker card survives the first paint (regression on the fix for finding 2)', () => {
  beforeEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
    state.lanes = []; state.blockers = []; state.thread = []; state.cards = [];
    mocks.sendCommand.mockReset();
    mocks.sendCommand.mockResolvedValue({ cards: [] });
  });

  it('does not drop every blocker card while the blockers slice is still null', async () => {
    // The page flattens a null blockers slice to an empty array for its own counting.
    // Handing that empty array to the strip would read as "no blocker is open" and drop
    // every card on first paint, before the fleet has said anything at all.
    state.cards = [blockerCard('blk-1', 'FLT-520', 'Sentry is unreachable', now - 1_000)];
    state.blockers = [blocker('b1', 'FLT-520', 'open')];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('needs-you')).toBeInTheDocument());
    expect(screen.getByTestId('question-card').textContent).toContain('Sentry is unreachable');
  });
});
