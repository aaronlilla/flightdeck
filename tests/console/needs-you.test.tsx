// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildNeeds, NeedsYou } from '../../src/console/components/NeedsYou.js';
import type { Integration, Lane } from '../../src/shared/console-model.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'jira_AB-12_1788460932645', ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'parked', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: { key: 'ask', text: 'NOT NULL or nullable?', opts: [], askedAt: Date.now() },
    pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    ...extra,
  };
}

// Final fidelity sweep #1: the ticket sheet band and the needs-you plates use the
// same headline rule, and the full run id shows up only in the title attribute --
// never as a second visible line.
describe('buildNeeds headline', () => {
  // 2026-09-08: the run id was still the fallback here -- fixed to fall through
  // to "Untitled run" the same way `laneHeadline` does everywhere else.
  it('titles a parked plate "Untitled run" when there is no ticket and no title', () => {
    const items = buildNeeds([lane({ ticket: null })], [], vi.fn());
    expect(items[0]?.title).toBe('Untitled run');
    expect(items[0]?.titleId).toBe('jira_AB-12_1788460932645');
  });

  it('titles a parked plate with the ticket, and carries the run id for the title attribute', () => {
    const items = buildNeeds([lane({ ticket: 'AB-12' })], [], vi.fn());
    expect(items[0]?.title).toBe('AB-12');
    expect(items[0]?.titleId).toBe('jira_AB-12_1788460932645');
  });

  it('never renders the full run id as its own visible text next to the ticket title', () => {
    const items = buildNeeds([lane({ ticket: 'AB-12' })], [], vi.fn());
    render(<NeedsYou items={items} />);
    const titleEl = screen.getByText('AB-12');
    expect(titleEl).toHaveAttribute('title', 'jira_AB-12_1788460932645');
    expect(screen.queryByText('jira_AB-12_1788460932645')).not.toBeInTheDocument();
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
    scope: null, lastHealthyAt: null, retryCount: 0,
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
      [lane({
        state: 'running', runaway: true, tokens: 1_840_000, tokenCap: 1_600_000, fails: 11, tokensPerMin: 260_000,
        question: null,
      })],
      [], vi.fn(),
    );
    expect(items[0]?.sub).toBe('1.8M / 1.6M');
    expect(items[0]?.line).toBe('retry loop ×11 · burning 260k tokens/min');
  });
});

// A stale ask (2026-09-07 live-board finding): a parked lane's question can come back
// with no readable text at all -- there is nothing there for a person to answer, ever,
// and it should stop reading as a normal ask the moment it's clearly abandoned (24h+).
describe('buildNeeds stale ask plate', () => {
  it('shows a stale ask as "stale ask from <lane>, <age>" with a Dismiss action once it is 24h+ old and empty', () => {
    const now = 1_000_000_000;
    const askedAt = now - 25 * 60 * 60_000;
    const onDismissAsk = vi.fn();
    const items = buildNeeds(
      [lane({ ticket: 'FLT-9', question: { key: 'stale-key', text: '', opts: [], askedAt } })],
      [], vi.fn(), undefined, now, onDismissAsk,
    );
    expect(items[0]?.title).toMatch(/^stale ask from /);
    expect(items[0]?.title).toContain('FLT-9');
    expect(items[0]?.cta).toBe('Dismiss');
    items[0]?.onClick();
    expect(onDismissAsk).toHaveBeenCalledWith('stale-key');
  });

  it('never puts a stale ask first when a normal need is also on the board', () => {
    const now = 1_000_000_000;
    const askedAt = now - 25 * 60 * 60_000;
    const items = buildNeeds(
      [
        lane({ id: 'stale-lane', ticket: 'FLT-9', question: { key: 'stale-key', text: '', opts: [], askedAt } }),
        lane({ id: 'normal-lane', ticket: 'FLT-10', question: { key: 'k2', text: 'dev or staging?', opts: [], askedAt: now } }),
      ],
      [], vi.fn(), undefined, now,
    );
    expect(items[0]?.cta).not.toBe('Dismiss');
    expect(items[items.length - 1]?.cta).toBe('Dismiss');
  });

  it('a question under 24h old with empty text still reads as a normal ask, not stale', () => {
    const now = 1_000_000_000;
    const items = buildNeeds(
      [lane({ ticket: 'FLT-9', question: { key: 'k', text: '', opts: [], askedAt: now - 60_000 } })],
      [], vi.fn(), undefined, now,
    );
    expect(items[0]?.cta).not.toBe('Dismiss');
  });

  // Sweep #6: a dismiss clears `lane.question` but leaves the lane `parked` -- nothing
  // resumes it. Before this fix the lane fell straight into the ordinary "asks: -"
  // plate, so a dismiss never actually left Needs You.
  it('a parked lane with no question at all (a dismissed ask) is not a need anymore', () => {
    const items = buildNeeds([lane({ ticket: 'FLT-9', question: null })], [], vi.fn());
    expect(items).toHaveLength(0);
  });
});
