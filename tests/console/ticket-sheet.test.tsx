// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TicketSheet } from '../../src/console/components/TicketSheet.js';
import type { Lane, Message } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({
  getRunThread: vi.fn(),
  getRunJournal: vi.fn(),
}));

import * as api from '../../src/console/api.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'jira_AB-12_1788460932645', ticket: 'AB-12', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: 'a schema question', stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null,
    ...extra,
  };
}

const noop = vi.fn();

function renderSheet(messages: Message[], laneExtra: Partial<Lane> = {}, journal: { t: number; text: string; color: string }[] = []) {
  vi.mocked(api.getRunThread).mockResolvedValue({ messages });
  vi.mocked(api.getRunJournal).mockResolvedValue({ entries: journal });
  return render(
    <TicketSheet
      lane={lane(laneExtra)} feedLive now={Date.now()}
      onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={noop} onUndo={noop} onOpenJournal={noop}
    />,
  );
}

describe('TicketSheet', () => {
  it('heads the band with the ticket alone, carrying the full run id in its title attribute', () => {
    renderSheet([]);
    const headline = screen.getByText('AB-12');
    expect(headline).toHaveAttribute('title', 'jira_AB-12_1788460932645');
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
  });

  it('heads the band with the run id alone when there is no ticket', () => {
    renderSheet([], { ticket: null });
    expect(screen.getByText('jira_AB-12_1788460932645')).toBeInTheDocument();
  });

  // The diff row for this line said the prototype uses "esc ✕"; the prototype's own
  // markup (markup_140_361_wrapped.txt:190) shows the TICKET sheet specifically using
  // "esc to close ✕" -- only the cost/sandbox/journal sheets (lines 254/267/277) use
  // the shorter "esc ✕". The row was wrong for this sheet; the source wins.
  it('closes with "esc to close ✕", matching the ticket sheet\'s own markup', () => {
    renderSheet([]);
    expect(screen.getByText('esc to close ✕')).toBeInTheDocument();
  });

  it('shows the run\'s own narrative journal, fetched separately from the thread', async () => {
    renderSheet([{ k: 'e1', type: 'event', text: 'heartbeat', ts: 2, source: 'system' }], {}, [
      { t: 1, text: 'polled AB-12 from queue', color: 'var(--ink2)' },
      { t: 2, text: 'sandbox fd-1 provisioned', color: 'var(--ink2)' },
    ]);
    await waitFor(() => expect(screen.getByText('polled AB-12 from queue')).toBeInTheDocument());
    expect(screen.getByText('sandbox fd-1 provisioned')).toBeInTheDocument();
    expect(vi.mocked(api.getRunJournal)).toHaveBeenCalledWith('jira_AB-12_1788460932645');
  });

  it('never shows lane.reason in the journal column -- the prototype has no such line', () => {
    renderSheet([], { reason: 'a schema question' });
    expect(screen.queryByText('a schema question')).not.toBeInTheDocument();
  });

  it('never shows a repeated cap-text footer -- the prototype has no such row', () => {
    renderSheet([], { tokens: 20, tokenCap: 10 });
    // capText would read "cap 10 tokens · ×2"; that string must not appear twice (once
    // is fine, from the header cost readout's tooltip elsewhere; none here).
    expect(screen.queryByText(/cap 10 tokens/)).not.toBeInTheDocument();
  });

  it('always shows the literal "ceiling 200k", matching the prototype, never a computed figure', () => {
    renderSheet([], { ctxCeiling: 180_000 });
    expect(screen.getByText(/ceiling 200k/)).toBeInTheDocument();
  });

  it('renders the draft PR line as static text with no link target', () => {
    renderSheet([], { pr: { no: 42, url: 'https://example.test/pr/42', files: 3, add: 10, del: 2, draft: true } });
    const link = screen.getByText('draft PR #42 ↗');
    expect(link).not.toHaveAttribute('href');
  });

  describe('band', () => {
    it('is glyph + label only for a normal running lane, no "since" time', () => {
      renderSheet([], { state: 'running', runaway: false });
      expect(screen.getByText('● running')).toBeInTheDocument();
    });

    it('adds the over-cap suffix for a runaway running lane', () => {
      renderSheet([], { state: 'running', runaway: true, tokens: 20, tokenCap: 10 });
      expect(screen.getByText('● running — over cap, retry loop')).toBeInTheDocument();
    });

    it('reads "parked — human needed since HH:MM" for a parked lane', () => {
      const since = new Date('2026-01-01T13:58:00').getTime();
      renderSheet([], { state: 'parked', since });
      expect(screen.getByText(new RegExp('^◆ parked — human needed since'))).toBeInTheDocument();
    });
  });

  describe('canPause / canKill', () => {
    it('excludes a runaway lane from both Pause and Kill', () => {
      renderSheet([], { state: 'running', runaway: true });
      expect(screen.queryByText('Pause')).not.toBeInTheDocument();
      expect(screen.queryByText('Kill')).not.toBeInTheDocument();
    });

    it('offers Pause and Kill for a normal running lane', () => {
      renderSheet([], { state: 'running', runaway: false });
      expect(screen.getByText('Pause')).toBeInTheDocument();
      expect(screen.getByText('Kill')).toBeInTheDocument();
    });

    it('offers Kill (not Pause) for a paused lane', () => {
      renderSheet([], { state: 'paused', runaway: false });
      expect(screen.queryByText('Pause')).not.toBeInTheDocument();
      expect(screen.getByText('Kill')).toBeInTheDocument();
    });

    // A blocked lane's own CTA (`laneCta`) is "Gate log ->", which only reopens this
    // same sheet -- for a lane blocked by a stuck-session signal or a stale park record
    // rather than an integration outage, that CTA leads nowhere. Confirmed live: a lane
    // stuck in `blocked` with no chain packet showed "GATE LOG ->" as its only action,
    // with no Resume and no Kill anywhere on the tile -- a genuine dead end. Kill must
    // always be here too, so every lane state keeps at least one way out.
    it('offers Kill for a blocked lane, so blocked is never a dead end', () => {
      renderSheet([], { state: 'blocked', runaway: false });
      expect(screen.getByText('Kill')).toBeInTheDocument();
    });
  });

  describe('pipeline nodes', () => {
    it('fills a done node solid with its state color and no sub-label needed to tell it apart from a ghost', () => {
      renderSheet([], { hop: 1, hopStatus: 'live' });
      // hop 0 (poll) is behind the current hop -> done, filled.
      const pollNode = screen.getByText('✓');
      expect(pollNode.getAttribute('style')).toContain('background: var(--run)');
      expect(pollNode.style.borderStyle).toBe('solid');
    });

    it('renders a ghost node with a dashed border and no glyph', () => {
      renderSheet([], { hop: 0, hopStatus: 'live' });
      // hop 5 (jira) is well past the current hop -> ghost.
      const nodes = screen.getAllByText('jira');
      const ghostNode = nodes[0]!.previousElementSibling as HTMLElement;
      expect(ghostNode.style.borderStyle).toBe('dashed');
    });

    it('shows a status badge under the live node', () => {
      renderSheet([], { hop: 2, hopStatus: 'live' });
      expect(screen.getByText('live')).toBeInTheDocument();
    });

    it('shows the sandbox id as the provision node\'s sub-label', () => {
      renderSheet([], {
        hop: 2,
        sandbox: { id: 'fd-9001', path: null, branch: 'b', pid: 1, sessionId: null, region: 'local', instanceType: 'x' },
      });
      const subLabel = screen.getAllByText('fd-9001').find((el) => el.tagName === 'DIV');
      expect(subLabel).toBeDefined();
    });
  });

  it('renders the run thread using per-type message cards, not flat text', async () => {
    renderSheet([
      { k: 'q1', type: 'question', text: 'NOT NULL or nullable?', ts: 1, source: 'AB-12', askKey: 'ask-1', opts: ['NOT NULL', 'nullable'] },
    ]);
    // MessageCard renders a question card with this labeled header; flat text never did.
    await waitFor(() => expect(screen.getByText('NOT NULL')).toBeInTheDocument());
    expect(screen.getByText('Question ·', { exact: false })).toHaveTextContent('Question · from AB-12');
  });

  // Every state the operator can see must offer a way to end the run. `exhausted`'s own
  // call to action answers 501, so without Kill in the sheet it is a dead end.
  it('offers Kill on an exhausted run, whose own action cannot resume it', async () => {
    renderSheet([], { state: 'exhausted', runaway: false });
    expect(await screen.findByText('Kill')).toBeInTheDocument();
  });
});
