// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LaneTile } from '../../src/console/components/LaneTile.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { Lane } from '../../src/shared/console-model.js';

// `LaneTile` renders `Linkify`, which reads `links` off the store -- every render in
// this file goes through a provider carrying the default (no jiraSite, no
// defaultRepo), so a bare ticket key or PR mention stays plain text unless a test
// says otherwise.
function wrap(node: ReactElement): ReactElement {
  const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
  return <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>{node}</StoreContext.Provider>;
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

describe('LaneTile', () => {
  it('opens the ticket sheet on click', async () => {
    const onOpen = vi.fn();
    render(<LaneTile lane={lane()} feedLive now={Date.now()} onOpen={onOpen} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    await userEvent.click(screen.getByTestId('lane-FLT-1'));
    expect(onOpen).toHaveBeenCalledWith('FLT-1');
  });

  it('shows Kill attempt and calls onCommand with kill for a runaway lane, without opening the sheet', async () => {
    const onOpen = vi.fn();
    const onCommand = vi.fn();
    render(<LaneTile lane={lane({ runaway: true })} feedLive now={Date.now()} onOpen={onOpen} onOpenCost={vi.fn()} onCommand={onCommand} onTip={vi.fn()} />);
    await userEvent.click(screen.getByText('Kill attempt'));
    expect(onCommand).toHaveBeenCalledWith('FLT-1', 'kill');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows the observed stamp once the feed drops', () => {
    render(<LaneTile lane={lane()} feedLive={false} now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText(/observed/)).toBeInTheDocument();
  });

  // 2026-09-08 rework: the pinned "◆ human needed" band above the headline is gone --
  // "nothing else above the title" (the brief's own tile order), and the YOU block
  // (below the chip row) is the card's most prominent element instead.
  it('renders the parked state label and the Answer CTA for a parked lane, with a YOU block', () => {
    render(<LaneTile lane={lane({ state: 'parked', you: 'Read the reason, then Resume or Kill.' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText(/parked/)).toBeInTheDocument();
    expect(screen.getByText('YOU')).toBeInTheDocument();
    expect(screen.getByText('Read the reason, then Resume or Kill.')).toBeInTheDocument();
    expect(screen.getByText('Answer →')).toBeInTheDocument();
  });

  // 2026-09-08 rework: the tile no longer derives its own sentence off stepN/stepTotal
  // -- `now` (the server's own sentence) is what the Now line reads, verbatim.
  it('renders the Now line off the server-computed sentence, not a raw step reading', () => {
    render(<LaneTile lane={lane({ stepN: 2, stepTotal: 9, stepText: 'retry loop', now: 'step 2/9 · retry loop' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('step 2/9 · retry loop')).toBeInTheDocument();
  });

  // POLISH-1 #2, corrected: cap text shows whenever cost exceeds cap, not only when
  // the lane also carries the separate `runaway` flag.
  it('shows no cap text on a normal tile, and the exceeded form once cost crosses cap', () => {
    const { rerender } = render(<LaneTile lane={lane({ tokens: 864_000, tokenCap: 4_000_000 })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText(/cap /)).not.toBeInTheDocument();
    rerender(wrap(<LaneTile lane={lane({ tokens: 5_500_000, tokenCap: 1_600_000, runaway: false })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />));
    expect(screen.getByText('cap 1.6M tokens · ×3')).toBeInTheDocument();
    rerender(wrap(<LaneTile lane={lane({ tokens: 5_500_000, tokenCap: 1_600_000, runaway: true })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />));
    expect(screen.getByText('cap 1.6M tokens · ×3')).toBeInTheDocument();
  });

  // Prototype's `fresh(l)` requires the source's own heartbeat flag, not only a
  // recent `verifiedAt`: a lane that stopped heartbeating reads observed, not verified.
  it('reads observed, not verified, once the lane stops heartbeating even with a fresh verifiedAt', () => {
    const now = Date.now();
    render(<LaneTile lane={lane({ heart: false, verifiedAt: now - 1_000 })} feedLive now={now} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText(/observed/)).toBeInTheDocument();
  });

  // POLISH-1 #3: an observed tile dims to 60% opacity, and its cost readout goes phosphor-off.
  it('dims to 60% opacity and drops the cost glow once the value is only observed', () => {
    render(<LaneTile lane={lane({ tokens: 1_120_000 })} feedLive={false} now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByTestId('lane-FLT-1')).toHaveStyle({ opacity: 0.6 });
    expect(screen.getByText('1.1M')).toHaveClass('ws');
  });

  // Final fidelity sweep #1: the tile's headline is always one line, exactly as the
  // prototype's `{{l.id}}` is -- a ticket heads it when the lane has one, otherwise
  // the run id does, and the full run id lives only in the element's title attribute.
  // 2026-09-08 rework: the run id never renders as visible text at all any more (not
  // even as a `title=` fallback) -- it lives only on the tile's own `data-run-id`.
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

  // The tile keeps the prototype's single CTA. Amend lives in the ticket sheet beside
  // Send, on a real composer; a `window.prompt` on the tile blocked automation and was
  // never in the design.
  it('renders no Amend action on the tile', () => {
    render(<LaneTile lane={lane()} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText('Amend')).toBeNull();
  });

  // H2.1: the headline bolds the ticket key and shows the title beside it.
  it('shows the ticket key bold and the title beside it when the server has titled the lane', () => {
    render(<LaneTile lane={lane({ ticket: 'FLT-9', title: 'the withdrawal fee is off by one' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('FLT-9')).toBeInTheDocument();
    expect(screen.getByText('the withdrawal fee is off by one')).toBeInTheDocument();
  });

  it('H2.1 fix: puts the ticket key and chips on line one and the title on its own second line, with the full title in the title attribute', () => {
    const longTitle = 'the withdrawal fee rounds down instead of to the nearest cent on every payout over five hundred dollars';
    render(<LaneTile lane={lane({ ticket: 'FLT-9', title: longTitle })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    const key = screen.getByText('FLT-9');
    const titleEl = screen.getByText(longTitle);
    expect(titleEl).toHaveAttribute('title', longTitle);
    // The key and the title must not share a text node/line -- they are two separate
    // elements once the fix lands, and the row holding the key holds no title text.
    expect(key.parentElement).not.toBe(titleEl.parentElement);
    expect(key.parentElement?.textContent).not.toContain(longTitle);
  });

  it('shows the title alone when the lane has no ticket key', () => {
    render(<LaneTile lane={lane({ ticket: null, kind: 'probe', title: 'Live probe of the runner' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('Live probe of the runner')).toBeInTheDocument();
  });

  it('shows a kind chip beside the model chip', () => {
    render(<LaneTile lane={lane({ kind: 'hotfix' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('hotfix')).toBeInTheDocument();
  });

  it('shows the server-computed now sentence in place of the raw step text', () => {
    render(<LaneTile lane={lane({ now: 'Working since 12:44 on a Sonnet session, 43 turns in, last did: ran tests.' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('Working since 12:44 on a Sonnet session, 43 turns in, last did: ran tests.')).toBeInTheDocument();
  });

  it('shows a PR summary line with the number as a link when the lane carries a PR', () => {
    render(<LaneTile lane={lane({
      state: 'done', pr: { no: 119, url: 'https://example.invalid/pr/119', files: 2, add: 41, del: 3, draft: true, checks: 'success', verdict: 'PASS WITH NOTES', merged: false },
    })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    const link = screen.getByText('PR #119');
    expect(link.closest('a')).toHaveAttribute('href', 'https://example.invalid/pr/119');
    expect(link.closest('a')).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/council PASS WITH NOTES/)).toBeInTheDocument();
  });

  it('never offers Merge on a done lane the server already knows would refuse, and shows the why', () => {
    render(<LaneTile lane={lane({ state: 'done', mergeable: { ok: false, why: 'checks are still running' } })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText(/merge/i)).not.toBeInTheDocument();
    expect(screen.getByText('checks are still running')).toBeInTheDocument();
  });

  // 2026-09-08: a 40-char sha in the sentence must never run off the tile, and the
  // full sentence stays readable in `title` even once the visible text clamps.
  // 2026-09-08 rework: the Now line is one line, ellipsis-clamped, with the full text
  // in `title=` -- the sheet's own longer sentence, not the tile's, is what used to
  // clamp to three lines. Shortening a 40-char sha is now the server's own job
  // (`laneGlance.ts`/`plain.ts` both go through `shortenShas`), so the fixture passes
  // an already-shortened sentence, the same shape `now` carries off the real server.
  it('renders a long now sentence on one ellipsis-clamped line, with the full text in title', () => {
    const long = 'Working on a very long sentence that mentions commit b3f9a21 and keeps going past what one line can show, on and on and on.';
    render(<LaneTile lane={lane({ now: long })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    const el = screen.getByTitle(long);
    expect(el).toHaveStyle({ textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
  });

  // 2026-09-08: retried tickets fold into one tile; the attempt chip now renders
  // inside the tile, on the chip row, instead of hanging below it in a second box.
  it('shows an attempt chip on the chip row when the tile carries one', () => {
    render(<LaneTile lane={lane()} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} attempts={{ position: 3, total: 3 }} />);
    expect(screen.getByText('attempt 3 of 3')).toBeInTheDocument();
  });

  it('renders no attempt chip when the tile carries none', () => {
    render(<LaneTile lane={lane()} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText(/attempt \d+ of \d+/)).toBeNull();
  });

  describe('live marker', () => {
    it('renders a pulsing live dot and the last-event age for a lane whose worker answers', () => {
      const now = Date.now();
      const { container } = render(
        <LaneTile lane={lane({ live: { alive: true, pid: 123, lastEventAt: now - 4_000, checkedAt: now } })} feedLive now={now} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />,
      );
      expect(container.querySelector('.live-pulse')).not.toBeNull();
      expect(screen.getByText(/last event 4s ago/)).toBeInTheDocument();
      expect(screen.queryByText(/STALLED/)).toBeNull();
    });

    it('sits in the tile footer, centred beside the freshness stamp, not under the header (2026-09-08)', () => {
      const now = Date.now();
      const { container } = render(
        <LaneTile lane={lane({ live: { alive: true, pid: 123, lastEventAt: now - 2_000, checkedAt: now } })} feedLive now={now} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />,
      );
      const marker = screen.getByTestId('live-marker');
      expect(screen.getByTestId('tile-footer').contains(marker)).toBe(true);
      expect(marker.querySelector('.live-pulse')).not.toBeNull();
      expect((marker as HTMLElement).style.justifyContent).toBe('center');
      const header = container.querySelector('.lane > div:first-child') as HTMLElement;
      expect(header.querySelector('.live-pulse')).toBeNull();
    });

    it('renders a red STALLED marker with no pulse for a running lane whose worker is gone', () => {
      const now = Date.now();
      const { container } = render(
        <LaneTile lane={lane({ state: 'running', live: { alive: false, pid: 123, lastEventAt: now - 400_000, checkedAt: now } })} feedLive now={now} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />,
      );
      expect(screen.getByText(/STALLED/)).toBeInTheDocument();
      expect(container.querySelector('.live-pulse')).toBeNull();
    });

    it('renders neither marker for a lane that has finished, alive or not', () => {
      const now = Date.now();
      render(
        <LaneTile lane={lane({ state: 'done', live: { alive: false, pid: null, lastEventAt: null, checkedAt: now } })} feedLive now={now} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />,
      );
      expect(screen.queryByText(/^live/)).toBeNull();
      expect(screen.queryByText(/STALLED/)).toBeNull();
    });
  });
});
