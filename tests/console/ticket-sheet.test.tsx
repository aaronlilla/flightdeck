// @vitest-environment jsdom
import type { JSX, ReactElement } from 'react';
import { useReducer } from 'react';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TicketSheet } from '../../src/console/components/TicketSheet.js';
import { Toast } from '../../src/console/components/Toast.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';
import type { Lane, LaneSummary, Message } from '../../src/shared/console-model.js';

// `TicketSheet` renders `Linkify` (in the summary, the story and the thread) which
// reads `links` off the store -- every render in this file goes through a provider
// carrying the default (no jiraSite, no defaultRepo). A real reducer (not a mocked
// no-op dispatch) so `useAction`'s and the reaudit poll's `pending-set`/
// `pending-clear`/`toast` dispatches actually change what renders, the same shape
// App.tsx gives every component in production -- and a mounted `<Toast>` alongside
// the sheet, since a failed action's feedback is a toast, not a receipt card here.
function Harness({ node }: { node: ReactElement }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({ ...initialState(), links: { jiraSite: null, defaultRepo: null } }));
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {node}
      <Toast toast={state.toast} />
    </StoreContext.Provider>
  );
}

function render(node: ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(<Harness node={node} />);
}

// `actions.ts` reads `api.ApiError` and `api.isConfirmPending`, so spreading the real
// module is what keeps them real; hand-rolling `ApiError` in the factory covers one of
// the two and leaves the next one to fail the same way.
vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return {
    ...actual,
    getRunThread: vi.fn(),
    getRunJournal: vi.fn(),
    getRunStory: vi.fn(),
    getRunSummary: vi.fn(),
    recheckRun: vi.fn(),
    reauditRun: vi.fn(),
    sendToRun: vi.fn(),
    amendRun: vi.fn(),
  };
});

import * as api from '../../src/console/api.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'jira_AB-12_1788460932645', ticket: 'AB-12', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: 'a schema question', stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, now: '', you: null,
    ...extra,
  };
}

const noop = vi.fn();

function renderSheet(
  messages: Message[], laneExtra: Partial<Lane> = {},
  journal: { t: number; text: string; color: string }[] = [], onAmendLane = noop,
  story: { entries: { at: number; kind: string; text: string; url: string | null }[]; brief: { path: string; excerpt: string } | null } = { entries: [], brief: null },
  focus?: 'audit',
  verbose = false,
) {
  vi.mocked(api.getRunThread).mockResolvedValue({ messages });
  vi.mocked(api.getRunJournal).mockResolvedValue({ entries: journal });
  vi.mocked(api.getRunStory).mockResolvedValue({
    id: laneExtra.id ?? 'jira_AB-12_1788460932645', title: laneExtra.title ?? null, kind: laneExtra.kind ?? 'manual',
    ticket: null, brief: story.brief, entries: story.entries,
  });
  vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null });
  return render(
    <TicketSheet
      lane={lane(laneExtra)} feedLive now={Date.now()} focus={focus} verbose={verbose}
      onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
      onSendLane={noop} onAmendLane={onAmendLane} onUndo={noop} onOpenJournal={noop}
    />,
  );
}

describe('TicketSheet', () => {
  // `amendRun`/`sendToRun`/`recheckRun` are now real spies backed by `api.js`'s own
  // module (the mock factory spreads `importOriginal`), shared across every test in
  // this file -- a call count from one test would otherwise leak into the next one's
  // `not.toHaveBeenCalled()`. Clearing call history (not the resolved-value stubs
  // each test sets for itself) before every test keeps each test's assertion about
  // its own render.
  beforeEach(() => { vi.clearAllMocks(); });

  // 2026-09-08: the big line is the lane's title when there is one, else the
  // ticket, else "Untitled run" -- never the run id, which lives only in the
  // title attribute.
  it('heads with the ticket when there is no title, carrying the full run id in its title attribute', () => {
    renderSheet([]);
    const headlines = screen.getAllByText('AB-12');
    expect(headlines.some((el) => el.getAttribute('title') === 'jira_AB-12_1788460932645')).toBe(true);
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
  });

  it('heads with the title over the ticket when the lane has both', () => {
    renderSheet([], { title: 'the withdrawal fee is off by one' });
    expect(screen.getByText('the withdrawal fee is off by one')).toBeInTheDocument();
  });

  it('reads "Untitled run" when there is neither a title nor a ticket, never the run id', () => {
    renderSheet([], { ticket: null });
    expect(screen.getByText('Untitled run')).toBeInTheDocument();
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
  });

  // The diff row for this line said the prototype uses "esc ✕"; the prototype's own
  // markup (markup_140_361_wrapped.txt:190) shows the TICKET sheet specifically using
  // "esc to close ✕" -- only the cost/sandbox/journal sheets (lines 254/267/277) use
  // the shorter "esc ✕". The row was wrong for this sheet; the source wins.
  it('closes with "esc to close ✕", matching the ticket sheet\'s own markup', () => {
    renderSheet([]);
    expect(screen.getByText('esc to close ✕')).toBeInTheDocument();
  });

  // Item 5: the Journal panel renders only in verbose mode.
  it('shows the run\'s own narrative journal, fetched separately from the thread, in verbose mode', async () => {
    renderSheet([{ k: 'e1', type: 'event', text: 'heartbeat', ts: 2, source: 'system' }], {}, [
      { t: 1, text: 'polled AB-12 from queue', color: 'var(--ink2)' },
      { t: 2, text: 'sandbox fd-1 provisioned', color: 'var(--ink2)' },
    ], noop, { entries: [], brief: null }, undefined, true);
    await waitFor(() => expect(screen.getByText('polled AB-12 from queue')).toBeInTheDocument());
    expect(screen.getByText('sandbox fd-1 provisioned')).toBeInTheDocument();
    expect(vi.mocked(api.getRunJournal)).toHaveBeenCalledWith('jira_AB-12_1788460932645');
  });

  it('renders no Journal panel in plain mode', async () => {
    renderSheet([], {}, [{ t: 1, text: 'polled AB-12 from queue', color: 'var(--ink2)' }]);
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-story')).toBeInTheDocument());
    expect(screen.queryByText('polled AB-12 from queue')).not.toBeInTheDocument();
    expect(screen.queryByText('Journal')).not.toBeInTheDocument();
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

  it('reads the ceiling off the lane\'s own ctxCeiling, matching the board card, never a hardcoded figure', () => {
    renderSheet([], { ctxCeiling: 150_000, ctxTokens: 109_500 });
    expect(screen.queryByText(/ceiling 200k/)).not.toBeInTheDocument();
    expect(screen.getByText(/ceiling 150k/)).toBeInTheDocument();
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

    // 2026-09-08: a lane parked on a context-ceiling handoff showed only the word
    // "parked" -- no hint of why. The band should append the run's own reason,
    // the same way the rail already reads it for a parking journal row.
    it('names a ceiling-handoff reason in the band, not just "parked"', () => {
      const since = new Date('2026-01-01T13:58:00').getTime();
      renderSheet([], {
        state: 'parked', since,
        reason: 'run.handoff context reached 152357 tokens, the implement class ceiling is 150000',
      });
      expect(screen.getByText(/context reached 152357 tokens, the implement class ceiling is 150000/)).toBeInTheDocument();
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

    // 2026-09-08: a parked lane with no open ask offered neither Resume nor Kill --
    // its own CTA is now Resume (laneVM), so the sheet's secondary button needs to
    // offer Kill too, or a lane parked on a context-ceiling handoff has no way out.
    it('offers Kill for a parked lane, alongside its own Resume CTA', () => {
      renderSheet([], { state: 'parked', runaway: false, question: null });
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

    // Item 3: the pipeline's provision node names the branch, a name the operator
    // recognizes, never the sandbox's own id; a sandbox with no branch reads "worktree".
    it('shows the branch name as the provision node\'s sub-label', () => {
      renderSheet([], {
        hop: 2,
        sandbox: { id: 'fd-9001', path: null, branch: 'feature/flt-201', pid: 1, sessionId: null, region: 'local', instanceType: 'x' },
      });
      const subLabel = screen.getAllByText('feature/flt-201').find((el) => el.tagName === 'DIV');
      expect(subLabel).toBeDefined();
      expect(screen.queryByText('fd-9001')).not.toBeInTheDocument();
    });

    it('falls back to "worktree" when the sandbox carries no branch', () => {
      renderSheet([], {
        hop: 2,
        sandbox: { id: 'fd-9001', path: null, branch: null, pid: 1, sessionId: null, region: 'local', instanceType: 'x' },
      });
      const subLabel = screen.getAllByText('worktree').find((el) => el.tagName === 'DIV');
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
    // Amend reaches the run through the callback App routes into the catalog, so what
    // this proves is what the sheet hands over, not which api function it reaches for.
    const onAmendLane = vi.fn().mockResolvedValue(undefined);
    renderSheet([], {}, [], onAmendLane);
    const input = screen.getByPlaceholderText(/Tell this run something/);
    await userEvent.type(input, 'also handle the null case');
    await userEvent.click(screen.getByText('Amend'));
    expect(onAmendLane).toHaveBeenCalledWith('jira_AB-12_1788460932645', 'also handle the null case');
  });

  it('C.1: does nothing when Amend is clicked with an empty draft', async () => {
    renderSheet([]);
    await userEvent.click(screen.getByText('Amend'));
    expect(vi.mocked(api.amendRun)).not.toHaveBeenCalled();
  });

  // W1: `sendAndRefetch` used to end in `.catch(() => undefined)`, so a `/send` refusal
  // (the dead-lane 409 this stream added) vanished with no trace in the sheet -- the
  // rail is behind the open sheet, so that was the whole of what the operator saw.
  // Every rejection now becomes a reply row in the sheet's own thread.
  it('W1: a rejected onSendLane renders a reply row in the sheet thread, and the composer clears', async () => {
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({
      id: 'jira_AB-12_1788460932645', title: null, kind: 'manual', ticket: null, brief: null, entries: [],
    });
    vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null });
    const onSendLane = vi.fn().mockRejectedValue(
      new Error('2026-09-04-forge-c2-rn has no live session; it ended earlier. Kill, verify or archive it instead.'),
    );
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()} verbose={false}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={onSendLane} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    const input = screen.getByPlaceholderText(/Tell this run something/);
    await userEvent.type(input, 'kill and remove this');
    await userEvent.click(screen.getByText('Send ⏎'));

    expect(input).toHaveValue('');
    await waitFor(() => {
      expect(screen.getByTestId('ticket-sheet-thread').textContent).toMatch(/has no live session/);
    });
  });

  // W1: `sendAndRefetch` used to end in `.catch(() => undefined)`, so a `/send` refusal
  // (the dead-lane 409 this stream added) vanished with no trace in the sheet -- the
  // rail is behind the open sheet, so that was the whole of what the operator saw.
  // Every rejection now becomes a reply row in the sheet's own thread.
  it('W1: a rejected onSendLane renders a reply row in the sheet thread, and the composer clears', async () => {
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({
      id: 'jira_AB-12_1788460932645', title: null, kind: 'manual', ticket: null, brief: null, entries: [],
    });
    vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null });
    const onSendLane = vi.fn().mockRejectedValue(
      new Error('2026-09-04-forge-c2-rn has no live session; it ended earlier. Kill, verify or archive it instead.'),
    );
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()} verbose={false}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={onSendLane}
        onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    const input = screen.getByPlaceholderText(/Tell this run something/);
    await userEvent.type(input, 'kill and remove this');
    await userEvent.click(screen.getByText('Send ⏎'));

    expect(input).toHaveValue('');
    await waitFor(() => {
      expect(screen.getByTestId('ticket-sheet-thread').textContent).toMatch(/has no live session/);
    });
  });

  // H2.4, updated by item 3: the ticket chip itself becomes the source link when
  // there is one, rather than a separate "source ↗" chip.
  it('shows the kind chip and links the ticket chip to sourceUrl when the lane carries one', () => {
    renderSheet([], { kind: 'ticket', sourceUrl: 'https://example.invalid/browse/AB-12' });
    expect(screen.getByText('ticket')).toBeInTheDocument();
    const link = screen.getAllByText('AB-12').find((el) => el.closest('a'));
    expect(link?.closest('a')).toHaveAttribute('href', 'https://example.invalid/browse/AB-12');
  });

  it('renders the ticket chip as plain text, not a link, when the lane has no sourceUrl', () => {
    renderSheet([], { sourceUrl: null });
    const chips = screen.getAllByText('AB-12');
    expect(chips.every((el) => el.closest('a') === null)).toBe(true);
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
  // Sweep #8: "View council" opened the sheet with nothing pointing at the council
  // content it promised. focus="audit" must scroll to and highlight the audit line
  // once summary data lands, and the audit line must list the deciding findings.
  it('scrolls to and highlights the audit line when opened with focus="audit", and lists the deciding findings', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: [], status: 's', next: 'Read the finding and decide.',
      audit: {
        verdict: 'FIX FIRST', reviewed: 3, total: 4, at: Date.now(), head: 'abc1234',
        findings: 2, findingsText: ['reviewer-a: the retry can double-charge', 'reviewer-b: no empty-body test'],
        stale: false, staleWhy: null,
      },
      readiness: { ok: false, why: 'council verdict is FIX FIRST', checks: 'success', behindBase: 0, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'jira_AB-12_1788460932645', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()} focus="audit"
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText('reviewer-a: the retry can double-charge')).toBeInTheDocument());
    expect(screen.getByText('reviewer-b: no empty-body test')).toBeInTheDocument();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  // Item 5: the live board's own `/run/:id/summary` took 11 s while the story
  // (1,387 ms) and the thread (68 ms) landed fast -- the sheet's body must never wait
  // on the slowest of the three. A summary promise that never resolves must not stop
  // the story or the thread from rendering the moment their own fetch lands.
  it('renders the story and the thread even while the summary is still loading', async () => {
    vi.mocked(api.getRunSummary).mockImplementation(() => new Promise<never>(() => {}));
    vi.mocked(api.getRunThread).mockResolvedValue({
      messages: [{ k: 'm1', type: 'reply', text: 'landed fast', ts: 1, source: 'S-1' }],
    });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({
      id: 'x', title: null, kind: 'manual', ticket: null, brief: null,
      entries: [{ at: 1, kind: 'plan', text: 'the story landed too', url: null }],
    });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText('the story landed too')).toBeInTheDocument());
    expect(screen.getByText('landed fast')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-sheet-summary')).toHaveTextContent('Checking the PR, its checks and the audit');
  });

  it('renders what/status/audit/readiness and Re-check/Re-audit buttons', async () => {
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: ['wired the summary block.', 'added the drift check.'],
      status: 'Working since 1:00 on a Sonnet session, 3 turns in.',
      next: 'Merge it.',
      audit: {
        verdict: 'PASS WITH NOTES', reviewed: 4, total: 4, at: Date.parse('2026-09-07T12:35:00Z'),
        head: '3982779abc', findings: 3, findingsText: [], stale: false, staleWhy: null,
      },
      readiness: { ok: true, why: null, checks: 'success', behindBase: 0, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
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
      next: 'Wait for checks.',
      audit: null, readiness: { ok: false, why: 'not audited yet', checks: 'pending', behindBase: null, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-audit')).toHaveTextContent('Not audited.'));
    expect(screen.getByTestId('ticket-sheet-readiness')).toHaveTextContent('Not ready: not audited yet.');
  });

  // Item 1: the live board printed "the base branch gained 46 commits since. base
  // gained 46 commits since." -- `readiness.why` already carries the drift clause
  // (`summary.ts#computeReadiness`); the sheet must never say it a second time.
  it('never repeats the drift clause -- readiness.why already carries it', async () => {
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: [], status: 's', next: 'Not ready yet.', audit: null,
      readiness: {
        ok: false, why: 'the base branch gained 46 commits since', checks: 'success', behindBase: 46, headMoved: false,
      },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-readiness')).toHaveTextContent('gained 46 commits since'));
    const text = screen.getByTestId('ticket-sheet-readiness').textContent ?? '';
    expect(text.match(/gained 46 commits since/g)).toHaveLength(1);
  });

  it('Re-check calls the API and refreshes the summary in place', async () => {
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: [], status: 'stale', next: 'Wait for checks.', audit: null,
      readiness: { ok: false, why: 'checks are pending', checks: 'pending', behindBase: null, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    let resolveRecheck!: (value: LaneSummary) => void;
    vi.mocked(api.recheckRun).mockReturnValue(new Promise((resolve) => { resolveRecheck = resolve; }));
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText('stale')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Re-check'));
    expect(vi.mocked(api.recheckRun)).toHaveBeenCalledWith('jira_AB-12_1788460932645');
    await waitFor(() => expect(screen.getByText('Re-checking…')).toBeInTheDocument());
    expect(screen.getByText('Re-checking…').closest('[data-busy]')).toHaveAttribute('aria-busy', 'true');
    resolveRecheck({
      what: [], status: 'fresh', next: 'Merge it.', audit: null, readiness: { ok: true, why: null, checks: 'success', behindBase: 0, headMoved: false },
    });
    await waitFor(() => expect(screen.getByText('fresh')).toBeInTheDocument());
    expect(screen.getByText('Re-check')).toBeInTheDocument();
    // The catalog's own sentence for a re-check names what it found, rather than the
    // fixed "Re-checked." the call site used to pass in.
    expect(screen.getByTestId('toast')).toHaveTextContent('re-checked: Merge it.');
  });

  it('Re-check never swallows a failure -- shows a visible toast instead', async () => {
    vi.mocked(api.getRunSummary).mockResolvedValue({
      what: [], status: 'stale', next: 'Wait for checks.', audit: null,
      readiness: { ok: false, why: 'checks are pending', checks: 'pending', behindBase: null, headMoved: false },
    });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    vi.mocked(api.recheckRun).mockRejectedValue(new api.ApiError(500, 'recheck blew up'));
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText('stale')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Re-check'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('recheck blew up'));
    expect(screen.getByText('Re-check')).toBeInTheDocument();
  });

  it('Re-audit disables itself while running, then re-enables once the audit head catches up', async () => {
    vi.mocked(api.getRunSummary)
      .mockResolvedValueOnce({
        what: [], status: 's', next: 'Re-audit.', audit: { verdict: 'FIX FIRST', reviewed: 1, total: 4, at: 1, head: 'old', findings: 1, findingsText: [], stale: true, staleWhy: 'moved' },
        readiness: { ok: false, why: 'the PR head moved since the audit', checks: 'success', behindBase: 0, headMoved: true },
      })
      .mockResolvedValueOnce({
        what: [], status: 's', next: 'Merge it.', audit: { verdict: 'PASS', reviewed: 4, total: 4, at: 2, head: 'new', findings: 0, findingsText: [], stale: false, staleWhy: null },
        readiness: { ok: true, why: null, checks: 'success', behindBase: 0, headMoved: false },
      });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    vi.mocked(api.reauditRun).mockResolvedValue({ started: true });
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-readiness')).toHaveTextContent('moved since the audit'));
    await userEvent.click(screen.getByText('Re-audit'));
    expect(vi.mocked(api.reauditRun)).toHaveBeenCalledWith('jira_AB-12_1788460932645');
    await waitFor(() => expect(screen.getByText('Re-auditing…')).toBeInTheDocument());
    expect(screen.getByText('Re-auditing…').closest('[data-busy]')).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-audit')).toHaveTextContent('PASS'), { timeout: 5_000 });
    expect(screen.getByText('Re-audit')).toBeInTheDocument();
    expect(screen.getByTestId('toast')).toHaveTextContent('Re-audit finished');
  });

  // The live board's own defect: a 501 `{"error":"not wired","reason":"no repo/PR on
  // record..."}` flipped the button back to "Re-audit" with nothing else shown --
  // `handleReaudit`'s `.catch(() => setReauditRunning(false))` threw the error text
  // away. Both fields must now show up in the toast.
  it('a 501 "not wired" reaudit failure shows both the error and the reason in a toast', async () => {
    const id = 'jira_REAUDIT-501_1788460932999';
    vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null });
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id, title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    vi.mocked(api.reauditRun).mockRejectedValue(
      new api.ApiError(501, 'not wired: no repo/PR on record for run x to re-audit'),
    );
    render(
      <TicketSheet
        lane={lane({ id })} feedLive now={Date.now()}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('ticket-sheet-audit')).toHaveTextContent('Not audited.'));
    await userEvent.click(screen.getByText('Re-audit'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('not wired'));
    expect(screen.getByTestId('toast')).toHaveTextContent('no repo/PR on record');
    expect(screen.getByText('Re-audit')).toBeInTheDocument();
  });
});

describe('TicketSheet: reply label (item 6)', () => {
  // Item 6: the live sheet labelled the worker's own report with the lane's whole
  // title, in capitals -- `MessageCard`'s reply label falls back to `labelFor(source)`,
  // and the sheet was passing the board-wide title lookup straight through. Every
  // reply inside a run's own thread is that run's own report, so it always reads
  // "Worker", never a lookup that can resolve to the lane's title.
  it('labels a run\'s own report "Worker", never the lane\'s title, even when labelFor is wired', async () => {
    const laneId = 'jira_AB-12_1788460932645';
    vi.mocked(api.getRunThread).mockResolvedValue({
      messages: [{ k: 'm1', type: 'reply', text: 'dedupe warden.health on an open unregistered trip', ts: 1, source: laneId }],
    });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({ id: laneId, title: null, kind: 'manual', ticket: null, brief: null, entries: [] });
    vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null });
    render(
      <TicketSheet
        lane={lane({ id: laneId })} feedLive now={Date.now()}
        labelFor={() => 'DEDUPE WARDEN.HEALTH ON AN OPEN UNREGISTERED TRIP'}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop}
        onSendLane={noop} onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText('dedupe warden.health on an open unregistered trip')).toBeInTheDocument());
    expect(screen.getByTestId('reply-label')).toHaveTextContent('Worker');
  });
});

// W3 (2026-09-08): the composer's Send goes to the Conductor with this lane as its
// context, and the cards that come back (the receipt for each tool the agent ran, its
// reply, any confirm card) render inside this sheet's own thread.
describe('W3: the sheet composer talks to the Conductor', () => {
  it('Send calls onSendLane with the lane id, and the returned reply rows land in the sheet thread', async () => {
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({
      id: 'jira_AB-12_1788460932645', title: null, kind: 'manual', ticket: null, brief: null, entries: [],
    });
    vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null });
    const onSendLane = vi.fn().mockResolvedValue({
      cards: [
        { k: 'op-1', type: 'operator', text: 'kill and remove this', ts: 1, source: 'operator' },
        { k: 'r-1', type: 'receipt', text: 'kill and remove proposed for AB-12, waiting on Confirm', ts: 2, source: 'conductor', resolved: 'ran', path: 'agent' },
        { k: 'c-1', type: 'reply', text: 'Kill and remove proposed; the Confirm card is waiting for you.', ts: 3, source: 'conductor', path: 'agent' },
        { k: 'cf-1', type: 'confirm', text: 'confirm?', ts: 4, source: 'conductor', blast: 'AB-12 stops now and leaves the board.', btns: [{ label: 'Confirm', cmd: 'confirm tok-1', cls: 'destroy' }, { label: 'Not now', cmd: 'dismiss tok-1' }] },
      ],
    });
    const onCommand = vi.fn();
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()} verbose={false}
        onClose={noop} onCommand={onCommand} onOpenCost={noop} onOpenSandbox={noop} onSendLane={onSendLane}
        onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    const input = screen.getByPlaceholderText(/Tell this run something/);
    await userEvent.type(input, 'kill and remove this');
    await userEvent.click(screen.getByText('Send ⏎'));

    expect(onSendLane).toHaveBeenCalledWith('jira_AB-12_1788460932645', 'kill and remove this');
    const thread = screen.getByTestId('ticket-sheet-thread');
    await waitFor(() => {
      expect(thread.textContent).toMatch(/Kill and remove proposed; the Confirm card is waiting for you\./);
    });
    expect(thread.textContent).toMatch(/kill and remove proposed for AB-12, waiting on Confirm/);
    expect(thread.textContent).toMatch(/kill and remove this/);
    expect(within(thread).queryByTestId('conductor-working')).not.toBeInTheDocument();
    await userEvent.click(within(thread).getByText('Confirm'));
    expect(onCommand).toHaveBeenCalledWith('jira_AB-12_1788460932645', 'confirm tok-1');
  });

  it('a working row shows while the Conductor answers, and turns into the timeout text when it does not', async () => {
    vi.mocked(api.getRunThread).mockResolvedValue({ messages: [] });
    vi.mocked(api.getRunJournal).mockResolvedValue({ entries: [] });
    vi.mocked(api.getRunStory).mockResolvedValue({
      id: 'jira_AB-12_1788460932645', title: null, kind: 'manual', ticket: null, brief: null, entries: [],
    });
    vi.mocked(api.getRunSummary).mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null });
    let release: (value: { cards: Message[] }) => void = () => {};
    const onSendLane = vi.fn().mockReturnValue(new Promise<{ cards: Message[] }>((resolve) => { release = resolve; }));
    render(
      <TicketSheet
        lane={lane()} feedLive now={Date.now()} verbose={false} conductorTimeoutMs={300}
        onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={onSendLane}
        onAmendLane={noop} onUndo={noop} onOpenJournal={noop}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText(/Tell this run something/), 'status?');
    await userEvent.click(screen.getByText('Send ⏎'));
    const thread = screen.getByTestId('ticket-sheet-thread');
    // The working row is up the moment Send is pressed; its held budget (300ms) is long
    // enough that this first read never races the timeout timer under load.
    expect(within(thread).getByTestId('conductor-working')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(thread).getByTestId('conductor-working').textContent).toBe('the Conductor did not answer in 0s; the grammar answered instead…');
    }, { timeout: 3000 });
    release({ cards: [{ k: 'c-2', type: 'reply', text: 'The Conductor could not answer (the Conductor did not answer in 120s). The grammar answered instead:', ts: 5, source: 'conductor', path: 'grammar' }] });
    await waitFor(() => expect(within(thread).queryByTestId('conductor-working')).not.toBeInTheDocument());
    expect(thread.textContent).toMatch(/The grammar answered instead:/);
  });
});
