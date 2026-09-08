// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { render } from './helpers/with-store.js';
import { describe, expect, it, vi } from 'vitest';

import { Filters } from '../../src/console/components/Filters.js';
import type { Lane, LaneState } from '../../src/shared/console-model.js';
import * as api from '../../src/console/api.js';

vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return {
    ...actual,
    postRetireFinished: vi.fn(async () => ({ ok: true, message: 'retired', jid: null, retired: [] })),
    postMergeReady: vi.fn(async () => ({ ok: true, message: 'merged', jid: null, outcomes: [] })),
  };
});

function lane(state: LaneState, extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state, reason: null, stepN: 1, stepTotal: 6, stepText: '',
    ctxTokens: 1000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: false, since: 0, startedAt: 0,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null, did: null, now: '', you: null,
    ...extra,
  };
}

// Row: chips are exactly all / needs me · N lanes / running / finished / one chip per
// distinct repo actually on the board, with no invented "today" chip and no counts on
// the repo chips (script_wrapped.txt 266).
describe('Filters chips', () => {
  it('never renders a "today" chip', () => {
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('running')]} archivedLanes={[]} showProbes={false} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()} />);
    expect(screen.queryByText('today')).not.toBeInTheDocument();
  });

  it('formats the needs-me chip as "needs me · N lanes"', () => {
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('parked')]} archivedLanes={[]} showProbes={false} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()} />);
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
        archivedLanes={[]} showProbes={false}
        now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()}
      />,
    );
    const chips = screen.getAllByText(/^flightdeck-/).map((el) => el.textContent);
    expect(chips).toEqual(['flightdeck-docs', 'flightdeck-rn']);
    expect(screen.queryByText('flightdeck-api')).not.toBeInTheDocument();
  });

  it('renders no repo chip at all when the board has no repository on any lane', () => {
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('running', { repo: null })]} archivedLanes={[]} showProbes={false} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()} />);
    expect(screen.queryByText(/^flightdeck-/)).not.toBeInTheDocument();
  });

  // H2.2
  it('renders an Archived chip with the archived count, and a Probes toggle chip', () => {
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('running')]} archivedLanes={[lane('killed', { id: 'FLT-2', retiredAt: 1 })]} showProbes={false} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()} />);
    expect(screen.getByText('Archived 1')).toBeInTheDocument();
    expect(screen.getByText('Probes')).toBeInTheDocument();
  });

  // Sweep #16: the chip counted raw lanes while the grid groups by ticket -- two
  // retired attempts on one ticket showed "Archived 2" for a grid that renders one tile.
  it('counts archived groups, not raw lanes, when two retired lanes share a ticket', () => {
    render(
      <Filters
        filter="all" sort="cost" repos={[]} lanes={[lane('running')]}
        archivedLanes={[
          lane('killed', { id: 'FLT-2-a1', ticket: 'FLT-2', attempt: 1, retiredAt: 1 }),
          lane('killed', { id: 'FLT-2-a2', ticket: 'FLT-2', attempt: 2, retiredAt: 2 }),
        ]}
        showProbes={false} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()}
      />,
    );
    expect(screen.getByText('Archived 1')).toBeInTheDocument();
  });

  it('the all count excludes probes until the Probes chip is on', () => {
    const lanes = [lane('running'), lane('running', { id: 'FLT-2', ticket: null, kind: 'probe' })];
    const { rerender } = render(<Filters filter="all" sort="cost" repos={[]} lanes={lanes} archivedLanes={[]} showProbes={false} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()} />);
    expect(screen.getByText('all 1')).toBeInTheDocument();
    rerender(<Filters filter="all" sort="cost" repos={[]} lanes={lanes} archivedLanes={[]} showProbes now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()} />);
    expect(screen.getByText('all 2')).toBeInTheDocument();
  });

  // H2.3. Clean up (postRetireFinished) and Merge ready (postMergeReady) are
  // irreversible catalog actions now, not callback props: each renders its own
  // `ActionButton` bound to its own spec, so a click calls its own `api.ts` export
  // on the first pass with no confirm token, and the two stay wired to two distinct
  // calls rather than one shared handler.
  it('renders the two bulk action buttons and wires them to their own handlers', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<Filters filter="all" sort="cost" repos={[]} lanes={[lane('running')]} archivedLanes={[]} showProbes={false} now={Date.now()} onFilter={vi.fn()} onSort={vi.fn()} onToggleProbes={vi.fn()} />);
    await userEvent.click(screen.getByText('Clean up'));
    await userEvent.click(screen.getByText('Merge ready'));
    expect(api.postRetireFinished).toHaveBeenCalledTimes(1);
    expect(api.postRetireFinished).toHaveBeenCalledWith(undefined);
    expect(api.postMergeReady).toHaveBeenCalledTimes(1);
    expect(api.postMergeReady).toHaveBeenCalledWith(undefined);
  });
});
