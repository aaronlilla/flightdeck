// @vitest-environment jsdom
/**
 * R-75 item 2 (`doctrine/design/FD Rail.dc.html` 1a, rewritten 2026-09-11; spec §3).
 * Aaron, 2026-09-11: "the chat needs to default to hugging the bottom of the chat until
 * you scroll up with a fast scroll-to-bottom functionality that keeps it sticking to the
 * bottom, like normal chatroom style".
 *
 * The rail opens at the bottom, stays pinned there, unpins when the reader scrolls up,
 * counts what arrived below, re-pins on the jump button, folds a long reply to its first
 * sentence behind a disclosure, and never renders a tool name.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { Feed, Message } from '../../src/shared/console-model.js';

const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };

/** jsdom lays nothing out, so the list element has no scroll metrics of its own. These
 *  are the metrics of a rail taller than its box: the assertions below are on the real
 *  element's real `scrollTop`, never on a spy standing in for one. */
const SCROLL_HEIGHT = 4_000;
const CLIENT_HEIGHT = 600;
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT;

let scrollHeightSpy: PropertyDescriptor | undefined;
let clientHeightSpy: PropertyDescriptor | undefined;

beforeEach(() => {
  scrollHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  clientHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => SCROLL_HEIGHT });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => CLIENT_HEIGHT });
});

afterEach(() => {
  if (scrollHeightSpy) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightSpy);
  if (clientHeightSpy) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightSpy);
});

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

function conversation(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    k: `m${i}`,
    type: (i % 2 === 0 ? 'operator' : 'reply') as Message['type'],
    text: `line ${i}`,
    ts: 1_000 + i,
    source: i % 2 === 0 ? 'operator' : 'conductor',
  }));
}

const FOUR_LINES = [
  'The retry now backs off before it gives up.',
  'It used to fire three times in a row with no pause at all.',
  'That is what filled the log with the same failure over and over.',
  'The pause is two seconds, then four, then eight.',
].join('\n');

describe('the rail hugs the bottom (R-75 item 2)', () => {
  it('opens scrolled to the bottom on first paint', () => {
    renderRail(conversation(40));
    const list = screen.getByTestId('rail-thread');
    expect(list.scrollTop).toBe(BOTTOM);
  });

  it('scrolling up unpins, and a new message is counted rather than followed', () => {
    const thread = conversation(40);
    const { rerender } = renderRail(thread);
    const list = screen.getByTestId('rail-thread');

    list.scrollTop = 0;
    fireEvent.scroll(list);

    const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
    const next = [...thread, { k: 'm40', type: 'reply' as const, text: 'line 40', ts: 2_000, source: 'conductor' }];
    act(() => {
      rerender(
        <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
          <ConductorRail
            thread={next} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
            onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
          />
        </StoreContext.Provider>,
      );
    });

    expect(list.scrollTop).toBe(0);
    expect(screen.getByTestId('rail-jump')).toHaveTextContent('↓ 1 new');
  });

  it('the jump button goes to the bottom, re-pins, and clears the count', async () => {
    const thread = conversation(40);
    const { rerender } = renderRail(thread);
    const list = screen.getByTestId('rail-thread');
    list.scrollTop = 0;
    fireEvent.scroll(list);

    const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
    const withMore = (extra: Message[]) => act(() => {
      rerender(
        <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
          <ConductorRail
            thread={[...thread, ...extra]} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
            onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
          />
        </StoreContext.Provider>,
      );
    });
    withMore([{ k: 'm40', type: 'reply', text: 'line 40', ts: 2_000, source: 'conductor' }]);
    expect(screen.getByTestId('rail-jump')).toHaveTextContent('↓ 1 new');

    await userEvent.click(screen.getByTestId('rail-jump'));
    expect(list.scrollTop).toBe(BOTTOM);
    expect(screen.queryByTestId('rail-jump')).not.toBeInTheDocument();

    // Re-pinned: the next message is followed, not counted.
    list.scrollTop = BOTTOM;
    withMore([
      { k: 'm40', type: 'reply', text: 'line 40', ts: 2_000, source: 'conductor' },
      { k: 'm41', type: 'reply', text: 'line 41', ts: 2_001, source: 'conductor' },
    ]);
    expect(screen.queryByTestId('rail-jump')).not.toBeInTheDocument();
    expect(list.scrollTop).toBe(BOTTOM);
  });

  it('counts every message that arrived below, not one', () => {
    const thread = conversation(40);
    const { rerender } = renderRail(thread);
    const list = screen.getByTestId('rail-thread');
    list.scrollTop = 0;
    fireEvent.scroll(list);
    const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
    act(() => {
      rerender(
        <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
          <ConductorRail
            thread={[...thread, ...conversation(3).map((m, i) => ({ ...m, k: `x${i}`, ts: 3_000 + i }))]}
            feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
            onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
          />
        </StoreContext.Provider>,
      );
    });
    expect(screen.getByTestId('rail-jump')).toHaveTextContent('↓ 3 new');
  });
});

describe('a long reply folds to its first sentence (R-75 item 2)', () => {
  it('shows the first sentence with a disclosure that expands to the whole reply', async () => {
    renderRail([{ k: 'long', type: 'reply', text: FOUR_LINES, ts: 1_000, source: 'FLT-9' }]);

    expect(screen.getByText('The retry now backs off before it gives up.')).toBeInTheDocument();
    expect(screen.queryByText(/The pause is two seconds/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('reply-disclosure'));
    expect(screen.getByText(/The pause is two seconds, then four, then eight\./)).toBeInTheDocument();
  });

  it('leaves a short reply alone, with no disclosure', () => {
    renderRail([{ k: 'short', type: 'reply', text: 'Merged and green.', ts: 1_000, source: 'FLT-9' }]);
    expect(screen.getByText('Merged and green.')).toBeInTheDocument();
    expect(screen.queryByTestId('reply-disclosure')).not.toBeInTheDocument();
  });
});

describe('no tool name renders in the rail (R-75 item 2)', () => {
  const TOOLS = ['Bash', 'Edit', 'Grep', 'mcp__atlassian__editJiraIssue'];

  it('keeps the tool list out of the rail, drawer closed and drawer open', async () => {
    renderRail([
      { k: 'op', type: 'operator', text: 'what happened', ts: 1, source: 'operator' },
      { k: 'act', type: 'activity', text: 'Worked 16:57 to 17:04: 140 commands', ts: 2, source: 'FLT-9', tools: TOOLS },
    ]);
    for (const tool of TOOLS) expect(document.body.textContent).not.toContain(tool);
    await userEvent.click(screen.getByTestId('activity-drawer'));
    for (const tool of TOOLS) expect(document.body.textContent).not.toContain(tool);
  });
});
