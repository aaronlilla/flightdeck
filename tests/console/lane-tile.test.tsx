// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LaneTile } from '../../src/console/components/LaneTile.js';
import type { Lane } from '../../src/shared/console-model.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null,
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

  it('renders the parked band and the Answer CTA for a parked lane', () => {
    render(<LaneTile lane={lane({ state: 'parked' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('◆ human needed')).toBeInTheDocument();
    expect(screen.getByText('Answer →')).toBeInTheDocument();
  });

  // POLISH-1 #1: `step N/M · ` prefixes the step text once the lane has a step total.
  it('prefixes the step text with step N/M when the lane has a step total', () => {
    render(<LaneTile lane={lane({ stepN: 2, stepTotal: 9, stepText: 'retry loop' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('step 2/9 · retry loop')).toBeInTheDocument();
  });

  // POLISH-1 #2, corrected: cap text shows whenever cost exceeds cap, not only when
  // the lane also carries the separate `runaway` flag.
  it('shows no cap text on a normal tile, and the exceeded form once cost crosses cap', () => {
    const { rerender } = render(<LaneTile lane={lane({ tokens: 864_000, tokenCap: 4_000_000 })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText(/cap /)).not.toBeInTheDocument();
    rerender(<LaneTile lane={lane({ tokens: 5_500_000, tokenCap: 1_600_000, runaway: false })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('cap 1.6M tokens · ×3')).toBeInTheDocument();
    rerender(<LaneTile lane={lane({ tokens: 5_500_000, tokenCap: 1_600_000, runaway: true })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
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
  it('shows the run id as the headline, and its own title, when there is no ticket', () => {
    render(<LaneTile lane={lane({ ticket: null, id: 'jira_AB-12_1788460932645' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    const headline = screen.getByText('jira_AB-12_1788460932645');
    expect(headline).toHaveAttribute('title', 'jira_AB-12_1788460932645');
  });

  it('heads with the ticket alone and carries the full run id only in the title attribute', () => {
    render(<LaneTile lane={lane({ ticket: 'AB-12', id: 'jira_AB-12_1788460932645' })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    const headline = screen.getByText('AB-12');
    expect(headline).toHaveAttribute('title', 'jira_AB-12_1788460932645');
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
  });
});
