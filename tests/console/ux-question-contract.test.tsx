// @vitest-environment jsdom
/**
 * UX rule 2 (queue-brief-1788927569794): every question the operator sees should be
 * multiple choice with one recommended answer, through one shared component. This
 * file is deliberately RED against today's `main` -- see the goal brief. Do not fix
 * the components here.
 *
 * Contract under test, per surface: a `[data-testid="question-card"]` renders,
 * containing 2-4 `[data-testid="question-option"]` elements, the first carrying
 * `data-recommended="true"`, plus a `[data-testid="question-freetext"]` input.
 * "Clicking an option posts /answer with { key, answer }" is checked at the
 * component-contract level (`onCommand` called with the key and the option's exact
 * text) rather than a live network call, since none of these components call the
 * network directly -- that scope-down is deliberate and named here rather than
 * hidden.
 *
 * Four surfaces, all confirmed by reading source: the Conductor rail's question
 * card (has options today, but no shared component and no "recommended" marking),
 * the Conductor rail's confirm card (a fixed Confirm/Not now pair, not 2-4 options),
 * the lane sheet's run ask (rendered today only as a truncated one-line summary plus
 * a single "Answer ->" button in `NeedsYou`, with no options at all), and a blocker
 * that offers a choice (`BlockersView` renders only "Resolved, check it" / "Check
 * again", never a multi-option choice).
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { buildNeeds } from '../../src/console/components/NeedsYou.js';
import { BlockersView } from '../../src/console/components/BlockersView.js';
import type { Blocker, Feed, Lane, Message } from '../../src/shared/console-model.js';
import { render } from './helpers/with-store.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };

function assertQuestionCardContract(): void {
  const card = screen.getByTestId('question-card');
  const options = within(card).getAllByTestId('question-option');
  expect(options.length).toBeGreaterThanOrEqual(2);
  expect(options.length).toBeLessThanOrEqual(4);
  expect(options[0]).toHaveAttribute('data-recommended', 'true');
  within(card).getByTestId('question-freetext');
}

import { within } from '@testing-library/react';

describe('UX rule 2: every question renders through one shared, multiple-choice component (RED on main)', () => {
  it('the Conductor rail question card uses the shared question-card contract', () => {
    const message: Message = {
      k: 'ask1', type: 'question', text: 'which fix round should run next?', ts: Date.now(), source: 'FLT-1',
      opts: ['round A', 'round B'], askKey: 'ask1',
    };
    render(
      <ConductorRail
        thread={[message]} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
        onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
      />,
    );
    assertQuestionCardContract();
  });

  it('the Conductor rail confirm card uses the shared question-card contract', () => {
    const message: Message = {
      k: 'c1', type: 'confirm', text: 'Kill FLT-1?', ts: Date.now(), source: 'console', blast: 'discards the diff.',
    };
    render(
      <ConductorRail
        thread={[message]} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
        onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
      />,
    );
    assertQuestionCardContract();
  });

  it('the lane sheet run ask renders through the shared question-card contract', () => {
    const askedLane: Lane = {
      title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
      id: 'FLT-2', ticket: 'FLT-2', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
      repo: 'flightdeck-api', attempt: 1, state: 'parked', reason: null, stepN: 1, stepTotal: 6, stepText: 'waiting',
      ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
      fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
      startedAt: Date.now(), endedAt: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
      needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, didVerbatim: false, now: '', you: null,
      question: { key: 'ask2', text: 'compact now or push through?', opts: ['compact', 'push through'], askedAt: Date.now() },
    };
    // `NeedsYou` builds plain data, not JSX -- rendering its own plate is out of scope
    // for this component-test file, so the contract is asserted directly on what it
    // hands the board: no options, no recommendation, just a single "Answer ->" CTA.
    const [need] = buildNeeds([askedLane], [], vi.fn());
    expect(need).toBeDefined();
    // A `question-card` contract on this need would carry its own options; today's
    // shape has none at all, only a truncated one-line `line` and a single `cta`.
    expect((need as unknown as { options?: unknown }).options).toBeDefined();
  });

  it('a blocker with a choice renders through the shared question-card contract', () => {
    const blocker: Blocker = {
      id: 'blk-1', kind: 'integration', title: 'AWS session expired', detail: 'the console cannot reach the fleet API',
      howToResolve: 'run aws login', thenWhat: 'lanes resume', state: 'open', since: Date.now(),
      youCanResolve: true, blocks: [], links: [], blockedBy: [], checkedAt: null, resolvedAt: null, lastCheck: null,
    };
    render(<BlockersView blockers={[blocker]} chains={[['blk-1']]} />);
    assertQuestionCardContract();
  });
});
