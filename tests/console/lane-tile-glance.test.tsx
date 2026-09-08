// @vitest-environment jsdom
/**
 * The board-at-a-glance tile rework (2026-09-08, Aaron, off the live board): row 1 is
 * ticket key + state, nothing above it; the title gets the full width below; the chip
 * row sits below the title, never beside it; a YOU block is the most prominent thing on
 * the card; Did/Now read as two quiet lines; the run id lives only in `data-run-id`.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LaneTile } from '../../src/console/components/LaneTile.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { Lane } from '../../src/shared/console-model.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, did: null, now: 'Working on it.', you: null,
    ...extra,
  };
}

function renderTile(l: Lane): ReturnType<typeof render> {
  const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
  return render(
    <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
      <LaneTile lane={l} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />
    </StoreContext.Provider>,
  );
}

describe('LaneTile board-at-a-glance rework', () => {
  it('carries the run id only on data-run-id, never as visible text', () => {
    renderTile(lane({ ticket: null, title: null, id: 'jira_AB-12_1788460932645' }));
    expect(screen.getByTestId('lane-jira_AB-12_1788460932645')).toHaveAttribute('data-run-id', 'jira_AB-12_1788460932645');
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
  });

  it('shows the title in full, with the full title in the title attribute', () => {
    renderTile(lane({ ticket: 'FLT-9', title: 'the withdrawal fee is off by one' }));
    const titleEl = screen.getByText('the withdrawal fee is off by one');
    expect(titleEl).toHaveAttribute('title', 'the withdrawal fee is off by one');
  });

  it('shows the key alone on the title line when there is no title', () => {
    renderTile(lane({ ticket: 'FLT-9', title: null }));
    // Row 1 carries the key bold; the title line falls back to the key too, per the
    // brief's own "a lane with no title shows the key alone on this line" -- so it is
    // expected here twice, not deduplicated away.
    expect(screen.getAllByText('FLT-9').length).toBe(2);
  });

  it('renders the chip row below the title, never beside it', () => {
    renderTile(lane({ ticket: 'FLT-9', title: 'a fairly short title' }));
    const titleEl = screen.getByText('a fairly short title');
    const modelChip = screen.getByText('sonnet-5');
    expect(modelChip.getBoundingClientRect().top).toBeGreaterThanOrEqual(titleEl.getBoundingClientRect().bottom);
  });

  it('renders a YOU block for a parked lane with a question', () => {
    renderTile(lane({ state: 'parked', question: { key: 'k', text: 'NOT NULL or nullable?', opts: [], askedAt: 0 }, you: 'Answer: NOT NULL or nullable?' }));
    expect(screen.getByText('YOU')).toBeInTheDocument();
    expect(screen.getByText('Answer: NOT NULL or nullable?')).toBeInTheDocument();
  });

  it('renders "Nothing needed from you" when you is null', () => {
    renderTile(lane({ state: 'running', you: null }));
    expect(screen.getByText('Nothing needed from you.')).toBeInTheDocument();
  });

  it('does not render a YOU label at all for a running lane with no ask', () => {
    renderTile(lane({ state: 'running', you: null }));
    expect(screen.queryByText('YOU')).not.toBeInTheDocument();
  });

  it('renders the Did line when did is present, and skips it when null', () => {
    const { rerender } = renderTile(lane({ did: 'Fixed the fee rounding bug.' }));
    expect(screen.getByText('Fixed the fee rounding bug.')).toBeInTheDocument();
    const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
    rerender(
      <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
        <LaneTile lane={lane({ did: null })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />
      </StoreContext.Provider>,
    );
    expect(screen.queryByText('Did')).not.toBeInTheDocument();
  });

  it('renders the Now line off lane.now', () => {
    renderTile(lane({ now: 'Working since 12:00 on a Sonnet session.' }));
    expect(screen.getByText('Working since 12:00 on a Sonnet session.')).toBeInTheDocument();
  });

  it('links a Jira key inside the title', () => {
    const state = { ...initialState(), links: { jiraSite: 'https://acme.atlassian.net', defaultRepo: null } };
    render(
      <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
        <LaneTile lane={lane({ ticket: 'FLT-9', title: 'fix BBZ-44 in the fee cap' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />
      </StoreContext.Provider>,
    );
    const link = screen.getByText('BBZ-44');
    expect(link.closest('a')).toHaveAttribute('href', 'https://acme.atlassian.net/browse/BBZ-44');
  });
});
