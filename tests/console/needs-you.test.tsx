// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildNeeds, NeedsYou } from '../../src/console/components/NeedsYou.js';
import type { Integration, Lane } from '../../src/shared/console-model.js';

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

describe('buildNeeds asks line', () => {
  // script_wrapped.txt 199: `l.question.text.slice(0,70)+'…'`, unconditional -- the
  // ellipsis is appended even when the question is well under 70 chars.
  it('carries the question text into the asks line with the prototype\'s unconditional ellipsis', () => {
    const items = buildNeeds([lane({ question: { key: 'ask', text: 'NOT NULL or nullable?', opts: [], askedAt: 0 } })], [], vi.fn());
    expect(items[0]?.line).toBe('asks: NOT NULL or nullable?…');
  });

  it('truncates a question past 70 chars before appending the ellipsis', () => {
    const text = 'x'.repeat(90);
    const items = buildNeeds([lane({ question: { key: 'ask', text, opts: [], askedAt: 0 } })], [], vi.fn());
    expect(items[0]?.line).toBe(`asks: ${'x'.repeat(70)}…`);
  });

  it('never renders a bare "asks:" when the inbox entry has no readable question', () => {
    const items = buildNeeds([lane({ question: { key: 'ask', text: '', opts: [], askedAt: 0 } })], [], vi.fn());
    expect(items[0]?.line).not.toBe('asks: ');
  });
});

function integration(extra: Partial<Integration> = {}): Integration {
  return {
    id: 'aws', kind: 'conn', name: 'AWS sandboxes', desc: '', latencyMs: null, status: 'down',
    checkedAt: Date.now(), since: Date.now() - 60_000, cause: 'SSO token expired 13:58 (12h lifetime)',
    effect: null, fix: null, fixLabel: null, dependents: ['FLT-211'], step: null, links: {},
    ...extra,
  };
}

// Row: NeedsYou.tsx AWS plate -- the second line names the real cause and a link
// that opens Settings, instead of a static "N lanes blocked" line with no link.
describe('buildNeeds integration plate', () => {
  it('renders the cause as the line and a "why + fix" link that opens Settings', () => {
    const onOpenSettings = vi.fn();
    const items = buildNeeds([], [integration()], vi.fn(), onOpenSettings);
    expect(items[0]?.line).toBe('SSO token expired 13:58 (12h lifetime)');
    expect(items[0]?.more?.label).toBe('why + fix');
    items[0]?.more?.onClick();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('keeps the dependents-blocked count in the sub line', () => {
    const items = buildNeeds([], [integration({ dependents: ['a', 'b', 'c'] })], vi.fn());
    expect(items[0]?.sub).toContain('3 lanes blocked');
  });
});

// Row: NeedsYou.tsx parked plate -- sub reads the elapsed wait time, not the static
// word "parked".
describe('buildNeeds parked plate', () => {
  it('shows elapsed waiting time in the sub line', () => {
    const now = 1_000_000;
    const items = buildNeeds([lane({ since: now - 5 * 60_000 })], [], vi.fn(), undefined, now);
    expect(items[0]?.sub).toBe('waiting 5m');
  });
});

// Row: NeedsYou.tsx over-cap plate -- sub shows actual spend vs cap, and the detail
// line names the retry loop, instead of a static "over cap" / mis-ordered burn text.
describe('buildNeeds over-cap plate', () => {
  it('shows spend vs cap in the sub line and the retry-loop detail in the line', () => {
    const items = buildNeeds(
      [lane({ state: 'running', runaway: true, costUsd: 901.5, capUsd: 10, fails: 11, burnUsdPerMin: 1.3, question: null })],
      [], vi.fn(),
    );
    expect(items[0]?.sub).toBe('$901.50 / $10');
    expect(items[0]?.line).toBe('retry loop ×11 · burning $1.30/min');
  });
});
