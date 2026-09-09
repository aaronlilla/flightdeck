// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useReducer } from 'react';

import { LaneTile } from '../../src/console/components/LaneTile.js';
import { StoreContext, initialState, reducer } from '../../src/console/store.js';
import type { Lane } from '../../src/shared/console-model.js';
import * as api from '../../src/console/api.js';

vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return { ...actual, killRun: vi.fn(async () => ({ ok: true, message: 'killed', jid: null })) };
});

// `LaneTile` renders `Linkify`, which reads `links` off the store -- every render in
// this file goes through a provider carrying the default (no jiraSite, no
// defaultRepo), so a bare ticket key or PR mention stays plain text unless a test
// says otherwise. A real reducer-backed store (not a stubbed dispatch) so `useAction`
// (kill on a runaway tile, below) actually runs: it dispatches `action-pending` /
// `action-result` and reads them back on the next render.
function StoreWrapper({ node }: { node: ReactElement }): ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return <StoreContext.Provider value={{ state, dispatch }}>{node}</StoreContext.Provider>;
}
function wrap(node: ReactElement): ReactElement {
  return <StoreWrapper node={node} />;
}
function render(node: ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(wrap(node));
}

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, now: '', you: null,
    ...extra,
  };
}

// 2026-09-09 (design 2/3, `doctrine/design/FD Board.dc.html`): the tile is a minimal
// card now -- key and state word, title, one now sentence, time in state, and exactly
// one CTA (`data-testid="primary-action"`). The chip row, the YOU block, the cost
// readout, the context gauge, the PR summary line, attempt chips and the live marker
// all moved to the ticket sheet; a click on the card still opens it.
describe('LaneTile', () => {
  it('opens the ticket sheet on click', async () => {
    const onOpen = vi.fn();
    render(<LaneTile lane={lane()} feedLive now={Date.now()} onOpen={onOpen} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    await userEvent.click(screen.getByTestId('lane-FLT-1'));
    expect(onOpen).toHaveBeenCalledWith('FLT-1');
  });

  it('shows Kill attempt and calls the kill action for a runaway lane, without opening the sheet', async () => {
    const onOpen = vi.fn();
    render(<LaneTile lane={lane({ runaway: true })} feedLive now={Date.now()} onOpen={onOpen} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    await userEvent.click(screen.getByText('Kill attempt'));
    // Kill is irreversible, so it runs through the catalog action (`ActionButton` /
    // `useAction`), not the `onCommand` callback prop: the click calls `api.killRun`
    // directly, on the first pass with no confirm token yet.
    expect(api.killRun).toHaveBeenCalledWith('FLT-1', 'killed from the console', undefined);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('carries exactly one primary action in the footer', () => {
    render(<LaneTile lane={lane()} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    const footer = screen.getByTestId('tile-footer');
    expect(footer.querySelectorAll('[data-testid="primary-action"]')).toHaveLength(1);
  });

  it('offers Answer for a parked lane with an open ask', () => {
    render(<LaneTile lane={lane({ state: 'parked', question: { key: 'k1', text: 'continue?', opts: ['yes', 'no'], askedAt: 0 } })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('Answer →')).toBeInTheDocument();
  });

  it('offers Resume, not Answer, for a parked lane with no open ask', () => {
    render(<LaneTile lane={lane({ state: 'parked', question: null })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText('Answer →')).not.toBeInTheDocument();
    expect(screen.getByText('Resume ▶')).toBeInTheDocument();
  });

  // 2026-09-08 rework, still true post-redesign: the tile no longer derives its own
  // sentence off stepN/stepTotal -- `now` (the server's own sentence) is what the Now
  // line reads, verbatim.
  it('renders the Now line off the server-computed sentence, not a raw step reading', () => {
    render(<LaneTile lane={lane({ stepN: 2, stepTotal: 9, stepText: 'retry loop', now: 'step 2/9 · retry loop' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('step 2/9 · retry loop')).toBeInTheDocument();
  });

  it('falls back to the server plain-text line when the lane has no `you` sentence', () => {
    render(<LaneTile lane={lane({ you: null, plain: 'compiling the worktree' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('compiling the worktree')).toBeInTheDocument();
  });

  // H2.1 (fixed 2026-09-09): a lane with neither a ticket nor a title shows nothing
  // where the title would go, and the run id never renders as visible text -- it
  // lives only on `data-run-id`.
  it('carries the run id only on data-run-id when there is no ticket and no title', () => {
    render(<LaneTile lane={lane({ ticket: null, id: 'jira_AB-12_1788460932645' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByTestId('lane-jira_AB-12_1788460932645')).toHaveAttribute('data-run-id', 'jira_AB-12_1788460932645');
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
  });

  it('heads with the ticket alone and carries the full run id only in data-run-id', () => {
    render(<LaneTile lane={lane({ ticket: 'AB-12', id: 'jira_AB-12_1788460932645' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getAllByText('AB-12').length).toBeGreaterThan(0);
    expect(screen.getByTestId('lane-jira_AB-12_1788460932645')).toHaveAttribute('data-run-id', 'jira_AB-12_1788460932645');
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
  });

  it('shows the ticket key bold and the title beside it when the server has titled the lane', () => {
    render(<LaneTile lane={lane({ ticket: 'FLT-9', title: 'the withdrawal fee is off by one' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('FLT-9')).toBeInTheDocument();
    expect(screen.getByText('the withdrawal fee is off by one')).toBeInTheDocument();
  });

  it('shows the title alone when the lane has no ticket key', () => {
    render(<LaneTile lane={lane({ ticket: null, kind: 'probe', title: 'Live probe of the runner' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('Live probe of the runner')).toBeInTheDocument();
  });

  it('never offers Merge on a done lane the server already knows would refuse', () => {
    render(<LaneTile lane={lane({ state: 'done', mergeable: { ok: false, why: 'checks are still running' } })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText(/merge now/i)).not.toBeInTheDocument();
  });

  it('shows the state word "Ready to merge" once the board itself knows the PR would land', () => {
    render(<LaneTile lane={lane({ mergeable: { ok: true }, pr: { no: 1, url: 'https://example.invalid/pr/1', files: 1, add: 1, del: 0, draft: false, checks: 'success', verdict: null, merged: false } })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('Ready to merge')).toBeInTheDocument();
  });

  it('shows the state word "Needs you" for a runaway lane', () => {
    render(<LaneTile lane={lane({ runaway: true })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('Needs you')).toBeInTheDocument();
  });

  it('shows a time-in-state line under the now sentence', () => {
    const now = Date.now();
    render(<LaneTile lane={lane({ since: now - 65_000 })} feedLive now={now} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    // The now sentence (`step 1/6 · working`, from the fixture's default step fields)
    // also ends in "working", so a bare /working$/ regex matches both lines -- pin to
    // the exact time-in-state text (`ago()` floors 65s to "1m") instead.
    expect(screen.getByText('1m working')).toBeInTheDocument();
  });
});
