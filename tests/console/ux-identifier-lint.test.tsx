// @vitest-environment jsdom
/**
 * UX rule 1 (queue-brief-1788927569794): no string of letters and numbers anywhere
 * the operator looks. This file is deliberately RED against today's `main` -- see
 * the goal brief. Do not fix the components here; a later brief flips each `it.fails`
 * to `it` once its component is fixed.
 *
 * Scope decision (token-budget, documented rather than silent): this file covers the
 * board card (LaneTile), its grouped wrapper (LaneGroupTile), the queue card
 * (QueueView) and the Conductor rail question card -- the four surfaces the brief
 * names. `TicketSheet` (the lane sheet) was read in full and does NOT leak a raw id
 * as visible text today (its headline goes through `laneHeadline`, which keeps the
 * run id out of `main` and only ever puts it in a `title` attribute) -- so it is not
 * included as a fifth red case here. A full sweep of every exported component in
 * `src/console/components/` (Settings, ActionButton, Toast, HoverCard, Freshness,
 * DisconnectedBanner, QueueOffBanner, Linkify, CommandPalette, JournalSheet, Filters,
 * FleetCostSheet, CostSheet, SandboxSheet, NeedsYou, TopBar, FlightReview, LanesGrid,
 * BlockersView) is left for a follow-up broadening pass.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LaneTile } from '../../src/console/components/LaneTile.js';
import { LaneGroupTile } from '../../src/console/components/LaneGroupTile.js';
import { QueueView } from '../../src/console/components/QueueView.js';
import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { groupLanesByTicket } from '../../src/console/laneVM.js';
import type { Feed, Lane, Message, QueueItem } from '../../src/shared/console-model.js';
import { render } from './helpers/with-store.js';

vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return {
    ...actual,
    getRunThread: vi.fn().mockResolvedValue({ messages: [] }),
    getRunJournal: vi.fn().mockResolvedValue({ entries: [] }),
    getRunStory: vi.fn().mockResolvedValue({ id: 'x', title: null, kind: 'manual', ticket: null, brief: null, entries: [] }),
    getRunSummary: vi.fn().mockResolvedValue({ what: [], status: '', next: '', audit: null, readiness: null }),
    mergeQueueItem: vi.fn(), removeQueueItem: vi.fn(), retryQueueItem: vi.fn(),
    pauseQueue: vi.fn(), resumeQueue: vi.fn(), addToQueue: vi.fn(), promoteQueueItem: vi.fn(),
  };
});

// A 12-hex-char id: long enough to match the brief's `/\b[0-9a-f]{12,}\b/` rule, but
// short of the 16-char floor `stripMachineIds`' own `HEX_KEY` redaction uses, and it
// matches none of `RUN_ID_PATTERNS` (no `S-`, `jira_`, `queue-` prefix) -- so it
// survives `stripMachineIds` completely unchanged, the same as a real opaque run id
// would if it happened to fall in that gap.
const RAW_HEX_ID = 'a1b2c3d4e5f6';
const RAW_QUEUE_BRIEF_ID = 'queue-brief-1788927569794';
const RAW_Q_ID = 'Q-56440c7b';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: RAW_HEX_ID, ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
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
    id: 'Q-1', source: 'ticket', input: 'ABC-1', ticket: null, repo: null, briefPath: null,
    branch: null, worktreePath: null, base: null, state: 'queued', reason: null, runKey: null,
    pr: null, journalIds: [], createdAt: Date.now(), updatedAt: Date.now(), title: null,
    ...extra,
  };
}

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };

describe('UX rule 1: no identifier text visible to the operator (RED on main)', () => {
  it('LaneTile does not render the raw lane id as its title text', () => {
    const manualLane = lane({ kind: 'manual', id: RAW_HEX_ID, ticket: null, title: null });
    render(<LaneTile lane={manualLane} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()} />);
    // Today: `titleLineText` falls back to the raw `lane.id` whenever a manual lane
    // has no ticket and `stripMachineIds` happens not to touch its shape -- so this
    // throws today, which is the point.
    expect(screen.queryByText(RAW_HEX_ID)).not.toBeInTheDocument();
  });

  it('LaneGroupTile (the grouped board card) does not render the raw lane id', () => {
    const manualLane = lane({ kind: 'manual', id: RAW_HEX_ID, ticket: null, title: null });
    const [group] = groupLanesByTicket([manualLane]);
    render(
      <LaneGroupTile
        group={group!} feedLive now={Date.now()} onOpen={vi.fn()} onOpenCost={vi.fn()} onCommand={vi.fn()} onTip={vi.fn()}
      />,
    );
    expect(screen.queryByText(RAW_HEX_ID)).not.toBeInTheDocument();
  });

  it.fails('the queue card does not render a bare Q-hex id as its title', () => {
    render(
      <QueueView
        items={[queueItem({ id: RAW_Q_ID, title: null, ticket: null })]}
        paused={false} maxInFlight={2}
      />,
    );
    // `QueueCard`'s title is `item.title ?? item.ticket ?? item.id` -- with both
    // null, today the id itself is the visible title.
    expect(screen.queryByText(RAW_Q_ID)).not.toBeInTheDocument();
  });

  it.fails('the Conductor rail question card does not render a raw run id as its source', () => {
    const message: Message = {
      k: 'ask1', type: 'question', text: 'placeholder question text', ts: Date.now(), source: RAW_QUEUE_BRIEF_ID,
      opts: ['A', 'B'], askKey: 'ask1',
    };
    render(
      <ConductorRail
        thread={[message]} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
        onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
      />,
    );
    // Today: `labelFor?.(message.source) ?? message.source` -- with no `labelFor`
    // prop, the raw id renders as the "Question · from ..." text.
    expect(screen.queryByText(new RegExp(RAW_QUEUE_BRIEF_ID))).not.toBeInTheDocument();
  });
});
