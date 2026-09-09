// @vitest-environment jsdom
/**
 * W5 (ask-cards-and-type-scale): the rail used to be a wall of observation rows --
 * "A lane: the fleet lost track of it (x22)", "jira-transition complete on BBZ-175",
 * "pr-merge complete" -- with a worker's question and the grammar's "I did not
 * understand that" buried in the middle (screenshot 2026-09-08 14:11). Every `event`/
 * `activity` row now moves to a closed-by-default "Activity" drawer with a count
 * badge; the rail thread itself shows only conversation.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { Feed, Message } from '../../src/shared/console-model.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };

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

/** Raw journal event slugs -- exactly the kind of machine text that used to leak
 *  straight into the rail (`external.complete`'s own `row.kind`, `jira-transition`,
 *  `liveness.stuck`) before it was rendered in words. None of these may appear
 *  anywhere in the rail, open drawer or closed. */
const RAW_EVENT_NAMES = ['jira-transition', 'jira-comment', 'jira-assign', 'external.complete', 'liveness.stuck', 'warden.parked', 'run.parked'];

function observationFixture(): Message[] {
  const obs: Message[] = [];
  for (let i = 0; i < 20; i += 1) {
    obs.push({ k: `warden-${i}`, type: 'event', text: `A lane: the fleet lost track of it`, ts: i, source: 'warden' });
  }
  for (let i = 0; i < 7; i += 1) {
    obs.push({ k: `jira-${i}`, type: 'event', text: `BBZ-175 moved to In Review and Haiping was assigned`, ts: 20 + i, source: `run-${i}` });
  }
  for (let i = 0; i < 3; i += 1) {
    obs.push({ k: `activity-${i}`, type: 'activity', text: `Worked 16:5${i} to 17:0${i}: 40 commands`, ts: 27 + i, source: `run-a${i}` });
  }
  return obs;
}

function conversationFixture(): Message[] {
  return [
    { k: 'op1', type: 'operator', text: 'why is lane 3 stuck', ts: 100, source: 'operator' },
    { k: 'rep1', type: 'reply', text: 'still working', ts: 101, source: 'conductor' },
    {
      k: 'q1', type: 'question', text: 'How should the long option row look?', ts: 102, source: 'FLT-9',
      askKey: 'ask-9',
      opts: [
        'Close this queue-brief ticket as a misroute with no changes, since the brief was written for a hand session and the queue launched it elsewhere',
        'Rebase onto origin/main and keep going',
        'Something else, I will type it',
      ],
    },
  ];
}

describe('rail hygiene (W5)', () => {
  it('renders only the conversation rows plus a closed drawer badged with the raw observation count', () => {
    const thread = [...observationFixture(), ...conversationFixture()];
    renderRail(thread);

    expect(screen.getByText('why is lane 3 stuck')).toBeInTheDocument();
    expect(screen.getByText('still working')).toBeInTheDocument();
    expect(screen.getByText('How should the long option row look?')).toBeInTheDocument();

    // No obs row is visible directly in the thread.
    expect(screen.queryByText(/the fleet lost track of it/)).not.toBeInTheDocument();
    expect(screen.queryByText(/BBZ-175 moved to In Review/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Worked 16:5/)).not.toBeInTheDocument();

    const drawer = screen.getByTestId('activity-drawer');
    expect(within(drawer).getByTestId('activity-drawer-badge')).toHaveTextContent('30');
    expect(screen.queryByTestId('activity-drawer-body')).not.toBeInTheDocument();
  });

  it('shows collapsed lines with counts once the drawer is opened', async () => {
    const thread = observationFixture();
    renderRail(thread);
    await userEvent.click(screen.getByTestId('activity-drawer'));
    const body = screen.getByTestId('activity-drawer-body');
    // A row is read whole rather than by `getByText`: since the narration layer landed the
    // collapsed line is a `rail-glance` span followed by the ` · <count>` text node, and
    // `getByText` only ever sees an element's own direct text. Reading the row's
    // `textContent` still asserts what this test guards -- the observation sentence and its
    // count, together, in one row of the drawer body -- and additionally that they are in
    // the same row rather than merely both somewhere in the drawer.
    const rows = within(body).getAllByTestId('activity-row').map((row) => row.textContent ?? '');
    expect(rows.some((row) => /the fleet lost track of it.*20/.test(row))).toBe(true);
    expect(rows.some((row) => /BBZ-175 moved to In Review and Haiping was assigned.*7/.test(row))).toBe(true);
  });

  it('never lets a raw journal event name reach the rail, closed or open', async () => {
    const thread = [...observationFixture(), ...conversationFixture()];
    renderRail(thread);
    for (const name of RAW_EVENT_NAMES) {
      expect(document.body.textContent).not.toContain(name);
    }
    await userEvent.click(screen.getByTestId('activity-drawer'));
    for (const name of RAW_EVENT_NAMES) {
      expect(document.body.textContent).not.toContain(name);
    }
  });

  it('renders every long option as its own full-width row on the rail', () => {
    renderRail(conversationFixture());
    const list = screen.getByTestId('question-options');
    expect(list.children).toHaveLength(3);
    expect(list.style.flexDirection).toBe('column');
  });

  it('renders no Activity drawer at all when there are no observation rows', () => {
    renderRail(conversationFixture());
    expect(screen.queryByTestId('activity-drawer')).not.toBeInTheDocument();
  });
});
