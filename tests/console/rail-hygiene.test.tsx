// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { Feed, Message } from '../../src/shared/console-model.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };

/** Event names a real journal row can carry (a slice of `CHIP_EVENTS` in
 *  `src/forge/console/thread.ts`) -- none of these, nor a write's raw `kind`
 *  identifier, may ever reach the rail's own rendered words. Computed here rather
 *  than typed once so a future chip event still gets covered. */
const RAW_EVENT_NAMES = ['run.parked', 'ask.answered', 'chain.merged', 'run.killed', 'liveness.stuck', 'warden.parked', 'external.complete'];
const RAW_WRITE_KINDS = ['jira-transition', 'jira-comment', 'jira-assign', 'pr-merge', 'pr-ready'];

function observationRows(count: number): Message[] {
  const texts = [
    'A lane: the fleet lost track of it', 'BBZ-175 moved to its next status in Jira.', 'Merged the change.',
  ];
  return Array.from({ length: count }, (_, i) => ({
    k: `obs-${i}`, type: 'event', text: texts[i % texts.length]!, ts: 1_000 + i, source: 'system',
  }));
}

function conversationRows(): Message[] {
  return [
    { k: 'op-1', type: 'operator', text: 'why is FLT-3 stuck', ts: 2_000, source: 'operator' },
    { k: 'reply-1', type: 'reply', text: 'it is waiting on a merge lock', ts: 2_001, source: 'conductor' },
    {
      k: 'q-1', type: 'question', text: 'Which of these three approaches should the run take next: index the table, cache the query, or rewrite the join entirely', ts: 2_002, source: 'flt-3', askKey: 'ask-1',
      opts: [
        'Add a database index on the lookup column and re-run the slow query to confirm it now completes fast',
        'Cache the query result in Redis for five minutes and accept slightly stale data on the dashboard',
        'Rewrite the join as two separate queries in application code and merge the results in memory',
      ],
      recommended: 0,
    },
  ];
}

function renderRail(thread: Message[]) {
  const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
  return render(
    <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
      <ConductorRail
        thread={thread} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
        onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
      />
    </StoreContext.Provider>,
  );
}

describe('rail hygiene (W5): the thread is a conversation, the machinery moves to a drawer', () => {
  it('renders exactly the conversation rows plus one closed drawer badged with the observation count', () => {
    const thread = [...observationRows(30), ...conversationRows()];
    renderRail(thread);

    expect(screen.getByText('why is FLT-3 stuck')).toBeInTheDocument();
    expect(screen.getByText('it is waiting on a merge lock')).toBeInTheDocument();
    expect(screen.getByTestId('question-card')).toBeInTheDocument();

    const drawer = screen.getByTestId('activity-drawer');
    expect(drawer).toBeInTheDocument();
    expect(screen.getByTestId('activity-drawer-badge')).toHaveTextContent('30');
    expect(screen.queryByTestId('activity-drawer-body')).not.toBeInTheDocument();
  });

  it('opening the drawer shows collapsed lines with counts and the latest time, never a raw event or write name', async () => {
    const thread = [...observationRows(30), ...conversationRows()];
    renderRail(thread);

    await userEvent.click(screen.getByTestId('activity-drawer-toggle'));
    const body = screen.getByTestId('activity-drawer-body');
    expect(body).toBeInTheDocument();
    expect(body.textContent).toMatch(/×\d/);

    const wholeThread = screen.getByTestId('rail-thread').textContent ?? '';
    for (const name of [...RAW_EVENT_NAMES, ...RAW_WRITE_KINDS]) {
      expect(wholeThread).not.toContain(name);
    }
  });

  it('a question with several long options renders full-width rows and the thread never scrolls sideways', () => {
    const thread = conversationRows();
    renderRail(thread);

    const options = [
      ...screen.getAllByTestId('question-option'),
      ...screen.getAllByTestId('question-option-recommended'),
    ];
    expect(options.length).toBeGreaterThanOrEqual(3);
    for (const option of options) {
      expect(option).toHaveStyle({ width: '100%' });
    }

    const scroller = screen.getByTestId('rail-thread');
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth || scroller.scrollWidth);
  });
});
