// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TicketSheet } from '../../src/console/components/TicketSheet.js';
import type { Lane, Message } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({
  getRunThread: vi.fn(),
}));

import * as api from '../../src/console/api.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'jira_AB-12_1788460932645', ticket: 'AB-12', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, costUsd: 1, capUsd: 10, burnUsdPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null,
    ...extra,
  };
}

const noop = vi.fn();

function renderSheet(messages: Message[], laneExtra: Partial<Lane> = {}) {
  vi.mocked(api.getRunThread).mockResolvedValue({ messages });
  return render(
    <TicketSheet
      lane={lane(laneExtra)} feedLive now={Date.now()}
      onClose={noop} onCommand={noop} onOpenCost={noop} onOpenSandbox={noop} onSendLane={noop}
    />,
  );
}

describe('TicketSheet', () => {
  // POLISH-2 #1: the band shows the ticket as the headline and the run id beneath it.
  it('heads the band with the ticket and keeps the run id as the small line', () => {
    renderSheet([]);
    expect(screen.getByText('AB-12')).toBeInTheDocument();
    const runId = screen.getByText('jira_AB-12_1788460932645');
    expect(runId).toHaveAttribute('title', 'jira_AB-12_1788460932645');
  });

  it('heads the band with the run id alone when there is no ticket', () => {
    renderSheet([], { ticket: null });
    expect(screen.getByText('jira_AB-12_1788460932645')).toBeInTheDocument();
  });

  // POLISH-2 #2: the journal column shows the run's reply cards and the console's receipts.
  it('shows reply and receipt cards in the journal column, not the whole thread', async () => {
    renderSheet([
      { k: 'r1', type: 'reply', text: 'checks passed on the third attempt', ts: 1, source: 'AB-12' },
      { k: 'e1', type: 'event', text: 'heartbeat', ts: 2, source: 'system' },
      { k: 'j1', type: 'receipt', text: 'paused AB-12', ts: 3, source: 'console', jid: 'J-1' },
    ]);
    // the reply's text shows in both columns (journal report, full run thread) -- two hits proves it landed in the journal too
    await waitFor(() => expect(screen.getAllByText('checks passed on the third attempt')).toHaveLength(2));
    expect(screen.getByText('J-1')).toBeInTheDocument();
    expect(screen.getAllByText('heartbeat')).toHaveLength(1); // only in the run thread column, not the journal
  });

  it('prints "no report yet" when the run has no reply or receipt cards', async () => {
    renderSheet([{ k: 'e1', type: 'event', text: 'heartbeat', ts: 1, source: 'system' }]);
    await waitFor(() => expect(screen.getByText('no report yet')).toBeInTheDocument());
  });
});
