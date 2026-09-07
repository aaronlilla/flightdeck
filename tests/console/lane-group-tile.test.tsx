// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LaneGroupTile } from '../../src/console/components/LaneGroupTile.js';
import { groupLanesByTicket } from '../../src/console/laneVM.js';
import type { Lane } from '../../src/shared/console-model.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null,
    ...extra,
  };
}

describe('LaneGroupTile', () => {
  it('renders a single-attempt group as a plain tile with no attempts chip', () => {
    const groups = groupLanesByTicket([lane()]);
    render(<LaneGroupTile group={groups[0]!} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByTestId('lane-FLT-1')).toBeInTheDocument();
    expect(screen.queryByText(/attempt \d+ of \d+/)).not.toBeInTheDocument();
  });

  it('shows an attempt N of M chip for a multi-attempt group, and a disclosure of the earlier ones', async () => {
    const groups = groupLanesByTicket([
      lane({ id: 'r1', attempt: 1, startedAt: 1, plain: 'first attempt failed the gate.' }),
      lane({ id: 'r2', attempt: 2, startedAt: 2, plain: 'second attempt is running now.' }),
    ]);
    const onCommand = vi.fn();
    render(<LaneGroupTile group={groups[0]!} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={onCommand} onTip={vi.fn()} />);
    expect(screen.getByText('attempt 2 of 2')).toBeInTheDocument();
    expect(screen.queryByText('first attempt failed the gate.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('attempt 2 of 2'));
    expect(screen.getByText('first attempt failed the gate.')).toBeInTheDocument();
  });

  it('never reads the position off Lane.attempt (the reopen counter) -- a lane reopened 25 times in a group of 4 still reads attempt 4 of 4', () => {
    const groups = groupLanesByTicket([
      lane({ id: 'r1', attempt: 25, startedAt: 1, plain: 'first attempt.' }),
      lane({ id: 'r2', attempt: 25, startedAt: 2, plain: 'second attempt.' }),
      lane({ id: 'r3', attempt: 25, startedAt: 3, plain: 'third attempt.' }),
      lane({ id: 'r4', attempt: 25, startedAt: 4, plain: 'fourth attempt, running now.' }),
    ]);
    render(<LaneGroupTile group={groups[0]!} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    expect(screen.getByText('attempt 4 of 4')).toBeInTheDocument();
  });

  it('lists the earlier attempts oldest first in the disclosure', async () => {
    const groups = groupLanesByTicket([
      lane({ id: 'r1', attempt: 1, startedAt: 1, plain: 'oldest attempt.' }),
      lane({ id: 'r2', attempt: 2, startedAt: 2, plain: 'middle attempt.' }),
      lane({ id: 'r3', attempt: 3, startedAt: 3, plain: 'newest attempt, running now.' }),
    ]);
    render(<LaneGroupTile group={groups[0]!} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    await userEvent.click(screen.getByText('attempt 3 of 3'));
    const texts = screen.getAllByText(/oldest attempt\.|middle attempt\./).map((el) => el.textContent);
    expect(texts).toEqual(['oldest attempt.', 'middle attempt.']);
  });
});
