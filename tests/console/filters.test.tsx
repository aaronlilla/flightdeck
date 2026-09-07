// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Filters } from '../../src/console/components/Filters.js';
import type { Lane, LaneState } from '../../src/shared/console-model.js';

function lane(state: LaneState, extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state, reason: null, stepN: 1, stepTotal: 6, stepText: '',
    ctxTokens: 1000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: false, since: 0, startedAt: 0,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    ...extra,
  };
}

// Row: chips are exactly all / needs me · N lanes / running / finished / one chip per
// distinct repo actually on the board, with no invented "today" chip and no counts on
// the repo chips (script_wrapped.txt 266).
describe('Filters chips', () => {
  it('never renders a "today" chip', () => {
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('running')]} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} />);
    expect(screen.queryByText('today')).not.toBeInTheDocument();
  });

  it('formats the needs-me chip as "needs me · N lanes"', () => {
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('parked')]} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} />);
    expect(screen.getByText('needs me · 1 lanes')).toBeInTheDocument();
  });

  // Fidelity sweep #1: the prototype's `renderVals` builds the repo chip row from the
  // distinct `repo` values across the lanes it's showing (script_wrapped.txt 266), in
  // first-seen order -- never the prototype's own two seed repos as a fixed pair.
  it('derives repo chips from the distinct repos on the board, in first-seen order, with no appended count', () => {
    render(
      <Filters
        filter="all" sort="cost" repos={['flightdeck-docs', 'flightdeck-rn']}
        lanes={[lane('running', { repo: 'flightdeck-docs' }), lane('running', { repo: 'flightdeck-rn' })]}
        now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()}
      />,
    );
    const chips = screen.getAllByText(/^flightdeck-/).map((el) => el.textContent);
    expect(chips).toEqual(['flightdeck-docs', 'flightdeck-rn']);
    expect(screen.queryByText('flightdeck-api')).not.toBeInTheDocument();
  });

  it('renders no repo chip at all when the board has no repository on any lane', () => {
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('running', { repo: null })]} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} />);
    expect(screen.queryByText(/^flightdeck-/)).not.toBeInTheDocument();
  });
});
