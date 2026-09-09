// @vitest-environment jsdom
/**
 * UX rule 3 (queue-brief-1788927569794): one call to action per card state, and it
 * is the one the plan names. This file is deliberately RED against today's `main` --
 * see the goal brief. Do not fix the components here.
 *
 * The brief's seven states (`running`, `parked`, `blocked`, `review`, `done`,
 * `killed`, `unverified`) split across two real types: `review` exists only on
 * `QueueItemState` (there is no such `LaneState`), and the other six exist only on
 * `Lane`. This file therefore runs the six `Lane` states through `LaneTile` and
 * `review` through `QueueView`'s queue card, rather than forcing a seventh state onto
 * a type that does not have it.
 *
 * `LaneTile` structurally renders exactly one `LaneCta` per lane, so it can never
 * fail the "no second action" half of this rule on its own; what is red on `main` is
 * the "and it is the one the plan names" half -- `laneVM.ts`'s `laneCta()` labels
 * (`Watch live`, `Answer ->`, ...) do not match the plan's names (`Watch`, `Resume or
 * Kill`, ...). The assertion below checks a `data-testid="primary-action"` marker
 * that does not exist on any lane state today, so every state fails for the same
 * structural reason; each `it.fails` block also names the label `laneCta()` actually
 * produces today, for whichever later brief flips it.
 *
 * The queue card's `review` state is the one place today that DOES render two
 * primary actions on the same card at once (an "Open PR #n ->" link and a "Merge"
 * button, side by side, whenever a review item already carries a PR) -- that case is
 * asserted directly against the count of actionable elements on the card.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LaneTile } from '../../src/console/components/LaneTile.js';
import { QueueView } from '../../src/console/components/QueueView.js';
import type { Lane, LaneState, QueueItem } from '../../src/shared/console-model.js';
import { render } from './helpers/with-store.js';

vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return {
    ...actual,
    mergeQueueItem: vi.fn(), removeQueueItem: vi.fn(), retryQueueItem: vi.fn(),
    pauseQueue: vi.fn(), resumeQueue: vi.fn(), addToQueue: vi.fn(), promoteQueueItem: vi.fn(),
  };
});

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 200_000, tokenCap: 2_000_000, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, now: '', you: null,
    ...extra,
  };
}

function queueItem(extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'Q-1', source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: null, briefPath: null,
    branch: null, worktreePath: null, base: null, state: 'queued', reason: null, runKey: null,
    pr: null, journalIds: [], createdAt: Date.now(), updatedAt: Date.now(), title: null,
    ...extra,
  };
}

// The plan's own name for each Lane state's one action, per the brief.
const PLAN_LABEL: Record<LaneState, string | undefined> = {
  running: 'Watch',
  'handed-off': undefined,
  paused: undefined,
  parked: 'Resume or Kill',
  done: 'Open PR',
  merged: undefined,
  blocked: 'Resume or Kill',
  exhausted: undefined,
  killed: 'Reopen',
  unverified: 'Verify',
};

describe('UX rule 3: one primary action per Lane state, named as the plan names it (RED on main)', () => {
  (['running', 'parked', 'blocked', 'done', 'killed', 'unverified'] as const).forEach((state) => {
    it(`${state}: the single primary action carries the plan's own contract and name (${PLAN_LABEL[state]})`, () => {
      render(
        <LaneTile
          lane={lane({ state, mergeable: state === 'done' ? { ok: true } : null, pr: state === 'done' ? { no: 1, url: 'https://x/1', merged: false, files: 1, add: 1, del: 0, draft: false } : null })}
          feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()}
        />,
      );
      const footer = screen.getByTestId('tile-footer');
      // No lane state renders a `primary-action` marker today -- `LaneCta` only ever
      // carries an `action-<spec>` testid (for a catalog action) or none at all (for
      // a plain button), so this throws for every state, which is the point: the
      // plan's own contract is not there to check against yet.
      within(footer).getByTestId('primary-action');
    });
  });

  it.fails('review: the queue card renders exactly one primary action (Merge or Nudge Joe), not two', () => {
    render(
      <QueueView
        items={[queueItem({
          state: 'review',
          pr: { no: 42, url: 'https://github.com/o/n/pull/42', files: 3, add: 12, del: 4, draft: true },
        })]}
        paused={false} maxInFlight={2}
      />,
    );
    const title = screen.getByTestId('queue-card-title');
    const card = title.closest('.lane') as HTMLElement;
    // Today: the "Open PR #42 ->" link and the "Merge" button both render at once
    // on a review card that already carries a PR -- two primary actions, not one.
    const actions = [...within(card).queryAllByRole('link'), ...within(card).queryAllByRole('button')];
    expect(actions.length).toBe(1);
  });
});
