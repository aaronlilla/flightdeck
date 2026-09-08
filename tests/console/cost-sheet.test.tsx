// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { render } from './helpers/with-store.js';
import { describe, expect, it, vi } from 'vitest';

import { CostSheet } from '../../src/console/components/CostSheet.js';
import type { CostStep, Lane } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({ getRunCost: vi.fn() }));
import * as api from '../../src/console/api.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-204', ticket: 'FLT-204', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 2, stepTotal: 6, stepText: 'working',
    ctxTokens: 70_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 5_500_000, tokenCap: 1_600_000, tokensPerMin: 260_000,
    fails: 2, hop: 2, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: true,
    needsAaron: null, did: null, now: '', you: null,
    ...extra,
  };
}

function renderSheet(laneExtra: Partial<Lane> = {}, steps: CostStep[] = [], capEnforcementFailedJid: string | null = null) {
  vi.mocked(api.getRunCost).mockResolvedValue({ steps, capEnforcementFailedJid });
  return render(<CostSheet lane={lane(laneExtra)} onClose={vi.fn()} onKill={vi.fn()} />);
}

describe('CostSheet', () => {
  it('splits tokens into input/output plus the model, not a flat total', () => {
    renderSheet({ ctxTokens: 40_000 });
    expect(screen.queryByText(/^40k tokens$/)).not.toBeInTheDocument();
  });

  it('shows "—" for burn when the lane is not running', () => {
    renderSheet({ state: 'done', tokensPerMin: 260_000 });
    expect(screen.getByText(/burn —\/min/)).toBeInTheDocument();
  });

  it('shows the real burn rate for a running lane', () => {
    renderSheet({ state: 'running', tokensPerMin: 260_000 });
    expect(screen.getByText(/burn 260k tokens\/min/)).toBeInTheDocument();
  });

  it('renders a by-step table from the real per-step data', async () => {
    renderSheet({}, [
      { t: 1, stepText: 'FLT-204 finished a turn', inputTokens: 12_000, outputTokens: 900, tokens: 12_900 },
      { t: 2, stepText: 'FLT-204 finished a turn', inputTokens: 8_000, outputTokens: 600, tokens: 8_600 },
    ]);
    await waitFor(() => expect(screen.getAllByText('FLT-204 finished a turn')).toHaveLength(2));
    expect(screen.getByText('12,900')).toBeInTheDocument();
    expect(screen.getByText('8,600')).toBeInTheDocument();
  });

  it('appends the real cap-enforcement-failure detail for a runaway lane, when the server names one', async () => {
    renderSheet({ runaway: true }, [], 'J-40211');
    await waitFor(() => expect(screen.getByText(/cap event failed \(J-40211\)/)).toBeInTheDocument());
  });

  it('never fabricates a cap-enforcement-failure jid when the server names none', async () => {
    renderSheet({ runaway: true }, [], null);
    await waitFor(() => expect(screen.getByText(/5,500,000 tokens/)).toBeInTheDocument());
    expect(screen.queryByText(/cap event failed/)).not.toBeInTheDocument();
  });
});
