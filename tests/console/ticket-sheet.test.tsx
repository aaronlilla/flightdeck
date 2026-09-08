// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TicketSheet } from '../../src/console/components/TicketSheet.js';
import type { Lane, Message } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({
  getRunThread: vi.fn(),
  getRunJournal: vi.fn(),
  getRunStory: vi.fn(),
  getRunSummary: vi.fn(),
  recheckRun: vi.fn(),
  reauditRun: vi.fn(),
}));

import * as api from '../../src/console/api.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
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

function renderSheet(
  messages: Message[], laneExtra: Partial<Lane> = {},
  journal: { t: number; text: string; color: string }[] = [], onAmendLane = noop,
  story: { entries: { at: number; kind: string; text: string; url: string | null }[]; brief: { path: string; excerpt: string } | null } = { entries: [], brief: null },
) {
  vi.mocked(api.getRunThread).mockResolvedValue({ messages });
  vi.mocked(api.getRunJournal).mockResolvedValue({ entries: journal });
  vi.mocked(api.getRunStory).mockResolvedValue({
    id: laneExtra.id ?? 'jira_AB-12_1788460932645', title: laneExtra.title ?? null, kind: laneExtra.kind ?? 'manual',
    ticket: null, brief: story.brief, entries: story.entries,
  });
  vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', audit: null, readiness: null });
  return render(
    <TicketSheet
      lane={lane(laneExtra)} feedLive now={Date.now()}
      onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={noop}
      onAmendLane={onAmendLane} onUndo={noop} onOpenJournal={noop}
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

  // Sweep #7: this line had never had an href -- fixed the same day the sweep found
  // it clicking through to nothing, opening in a new tab like every other PR link.
  it('renders the draft PR line as a working link that opens in a new tab', () => {
    renderSheet([], { pr: { no: 42, url: 'https://example.test/pr/42', files: 3, add: 10, del: 2, draft: true } });
    const link = screen.getByText('draft PR #42 ↗');
    expect(link).toHaveAttribute('href', 'https://example.test/pr/42');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
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

  // C.1: an Amend action beside Send, sharing the composer's draft text but reaching
  // the run through the brief-amendment path rather than a plain inbox message.
  it('C.1: shows an Amend action beside Send and posts the composer\'s draft through onAmendLane', async () => {
    const onAmendLane = vi.fn();
    renderSheet([], {}, [], onAmendLane);
    const input = screen.getByPlaceholderText(/message /);
    await userEvent.type(input, 'also handle the null case');
    await userEvent.click(screen.getByText('Amend'));
    expect(onAmendLane).toHaveBeenCalledWith('jira_AB-12_1788460932645', 'also handle the null case');
  });

  it('C.1: does nothing when Amend is clicked with an empty draft', async () => {
    const onAmendLane = vi.fn();
    renderSheet([], {}, [], onAmendLane);
    await userEvent.click(screen.getByText('Amend'));
    expect(onAmendLane).not.toHaveBeenCalled();
  });

  // H2.4
  it('shows the kind chip and a source link when the lane carries a sourceUrl', () => {
    renderSheet([], { kind: 'ticket', sourceUrl: 'https://example.invalid/browse/AB-12' });
    expect(screen.getByText('ticket')).toBeInTheDocument();
    const link = screen.getByText('source ↗');
    expect(link.closest('a')).toHaveAttribute('href', 'https://example.invalid/browse/AB-12');
  });

  it('renders no source link when the lane has none', () => {
    renderSheet([], { sourceUrl: null });
    expect(screen.queryByText('source ↗')).not.toBeInTheDocument();
  });

  it('renders the Story section as a dated list of sentences, before the journal panel', async () => {
    renderSheet([], {}, [], noop, {
      entries: [
        { at: 1, kind: 'ticket', text: 'started on AB-12', url: null },
        { at: 2, kind: 'pr', text: 'opened PR #42', url: 'https://example.invalid/pr/42' },
      ],
      brief: null,
    });
    await waitFor(() => expect(screen.getByText('started on AB-12')).toBeInTheDocument());
    const prLine = screen.getByText('opened PR #42');
    expect(prLine.closest('a')).toHaveAttribute('href', 'https://example.invalid/pr/42');
  });

  it('shows a Why not merged line when the lane has a PR and mergeable says no', () => {
    renderSheet([], {
      pr: { no: 42, url: 'https://example.test/pr/42', files: 1, add: 1, del: 0, draft: true },
      mergeable: { ok: false, why: 'checks are still running' },
    });
    expect(screen.getByText(/Why not merged/)).toHaveTextContent('Why not merged: checks are still running');
  });

  it('renders no Why not merged line when the lane has no PR', () => {
    renderSheet([], { pr: null, mergeable: { ok: false, why: 'checks are still running' } });
    expect(screen.queryByText(/Why not merged/)).not.toBeInTheDocument();
  });

  it('renders the brief excerpt collapsed by default, in a disclosure', async () => {
    renderSheet([], {}, [], noop, { entries: [], brief: { path: 'briefs/AB-12.md', excerpt: 'fix the withdrawal fee rounding' } });
    await waitFor(() => expect(screen.getByText('brief')).toBeInTheDocument());
    expect(screen.queryByText('fix the withdrawal fee rounding')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('brief'));
    expect(screen.getByText('fix the withdrawal fee rounding')).toBeInTheDocument();
  });
});

describe('TicketSheet: Summary block', () => {
  it('renders what/status/audit/readiness and Re-check/Re-audit buttons', async () => {
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: ['wired the summary block.', 'added the drift check.'],
      status: 'Working since 1:00 on a Sonnet session, 3 turns in.',
      audit: {
        verdict: 'PASS WITH NOTES', reviewed: 4, total: 4, at: Date.parse('2026-09-07T12:35:00Z'),
        head: '3982779abc', findings: 3, stale: false, staleWhy: null,
      },
      readiness: { ok: true, why: null, checks: 'success', behindBase: 0, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={noop}
        onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText('wired the summary block.')).toBeInTheDocument());
    expect(screen.getByText('added the drift check.')).toBeInTheDocument();
    expect(screen.getByText('Working since 1:00 on a Sonnet session, 3 turns in.')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-sheet-audit')).toHaveTextContent('Council PASS WITH NOTES, 4 of 4 reviewed, 3 findings');
    expect(screen.getByTestId('ticket-sheet-readiness')).toHaveTextContent('Ready to merge.');
    expect(screen.getByText('Re-check')).toBeInTheDocument();
    expect(screen.getByText('Re-audit')).toBeInTheDocument();
  });

  it('shows "Not audited" and the not-ready reason when there is no council verdict yet', async () => {
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: [], status: 'Draft PR #9 is open with checks pending and no council verdict yet; waiting for your Merge.',
      audit: null, readiness: { ok: false, why: 'not audited yet', checks: 'pending', behindBase: null, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={noop}
        onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-audit')).toHaveTextContent('Not audited.'));
    expect(screen.getByTestId('ticket-sheet-readiness')).toHaveTextContent('Not ready: not audited yet.');
  });

  it('Re-check calls the API and refreshes the summary in place', async () => {
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: [], status: 'stale', audit: null,
      readiness: { ok: false, why: 'checks are pending', checks: 'pending', behindBase: null, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    vi.mocked(api.recheckRun).mockResolvedValue({
      what: [], status: 'fresh', audit: null, readiness: { ok: true, why: null, checks: 'success', behindBase: 0, headMoved: false },
    });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={noop}
        onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText('stale')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Re-check'));
    expect(vi.mocked(api.recheckRun)).toHaveBeenCalledWith('jira_AB-12_1788460932645');
    await waitFor(() => expect(screen.getByText('fresh')).toBeInTheDocument());
  });

  it('Re-audit disables itself while running, then re-enables once the audit head catches up', async () => {
    vi.mocked(api.getRunSummary)
      .mockResolvedValueOnce({
        what: [], status: 's', audit: { verdict: 'FIX FIRST', reviewed: 1, total: 4, at: 1, head: 'old', findings: 1, stale: true, staleWhy: 'moved' },
        readiness: { ok: false, why: 'the PR head moved since the audit', checks: 'success', behindBase: 0, headMoved: true },
      })
      .mockResolvedValueOnce({
        what: [], status: 's', audit: { verdict: 'PASS', reviewed: 4, total: 4, at: 2, head: 'new', findings: 0, stale: false, staleWhy: null },
        readiness: { ok: true, why: null, checks: 'success', behindBase: 0, headMoved: false },
      });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    vi.mocked(api.reauditRun).mockResolvedValue({ started: true });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={noop}
        onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-readiness')).toHaveTextContent('moved since the audit'));
    await userEvent.click(screen.getByText('Re-audit'));
    expect(vi.mocked(api.reauditRun)).toHaveBeenCalledWith('jira_AB-12_1788460932645');
    await waitFor(() => expect(screen.getByText('Re-auditing…')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-audit')).toHaveTextContent('PASS'), { timeout: 5_000 });
    expect(screen.getByText('Re-audit')).toBeInTheDocument();
  });
});
