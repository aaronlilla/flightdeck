// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildNeeds, NeedsYou } from '../../src/console/components/NeedsYou.js';
import type { Lane } from '../../src/shared/console-model.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'jira_AB-12_1788460932645', ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'parked', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, costUsd: 1, capUsd: 10, burnUsdPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: { key: 'ask', text: 'NOT NULL or nullable?', opts: [], askedAt: Date.now() },
    pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    ...extra,
  };
}

// POLISH-2 #1: the ticket sheet band and the needs-you plates use the same headline rule.
describe('buildNeeds headline', () => {
  it('titles a parked plate with the run id when there is no ticket', () => {
    const items = buildNeeds([lane({ ticket: null })], [], vi.fn());
    expect(items[0]?.title).toBe('jira_AB-12_1788460932645');
    expect(items[0]?.runId).toBeNull();
  });

  it('titles a parked plate with the ticket, and keeps the run id as a small secondary field', () => {
    const items = buildNeeds([lane({ ticket: 'AB-12' })], [], vi.fn());
    expect(items[0]?.title).toBe('AB-12');
    expect(items[0]?.runId).toBe('jira_AB-12_1788460932645');
  });

  it('renders the run id next to the ticket title', () => {
    const items = buildNeeds([lane({ ticket: 'AB-12' })], [], vi.fn());
    render(<NeedsYou items={items} />);
    expect(screen.getByText('AB-12')).toBeInTheDocument();
    expect(screen.getByText('jira_AB-12_1788460932645')).toBeInTheDocument();
  });
});
