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
});
