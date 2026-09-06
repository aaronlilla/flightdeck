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
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, costUsd: 1, capUsd: 10, burnUsdPerMin: 0,
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

  // POLISH-1 #2: no cap text next to the cost unless the lane is runaway.
  it('shows no cap text on a normal tile, and the exceeded form on a runaway one', () => {
    const { rerender } = render(<LaneTile lane={lane({ costUsd: 4.32, capUsd: 20 })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.queryByText(/cap \$/)).not.toBeInTheDocument();
    rerender(<LaneTile lane={lane({ costUsd: 27.5, capUsd: 8, runaway: true })} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('cap $8 · exceeded ×3.4')).toBeInTheDocument();
  });

  // POLISH-1 #3: an observed tile dims to 60% opacity, and its cost readout goes phosphor-off.
  it('dims to 60% opacity and drops the cost glow once the value is only observed', () => {
    render(<LaneTile lane={lane({ costUsd: 5.6 })} feedLive={false} now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByTestId('lane-FLT-1')).toHaveStyle({ opacity: 0.6 });
    expect(screen.getByText('$5.60')).toHaveClass('ws');
  });
});
