// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConductorRail } from '../../src/console/components/ConductorRail.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type { Feed, Message } from '../../src/shared/console-model.js';

// jsdom lays nothing out, so the thread's geometry is pinned by hand: a 1000px tall
// content in a 300px viewport. `scrollTop` itself is real on a jsdom element.
const feedUp: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: Date.now() };

function reply(i: number): Message {
  return { k: `m-${i}`, type: 'reply', text: `message ${i}`, ts: Date.now() + i, source: 'conductor' };
}

function fixGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
}

function railFor(thread: Message[]) {
  const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
  return (
    <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>
      <ConductorRail
        thread={thread} feed={feedUp} now={Date.now()} composer="" onComposerChange={vi.fn()}
        onSend={vi.fn()} onCommand={vi.fn()} onUndo={vi.fn()} onOpenJournal={vi.fn()}
      />
    </StoreContext.Provider>
  );
}

describe('the rail thread scrolls like a chat', () => {
  it('opens pinned to the newest message and follows new ones while pinned', () => {
    const thread = Array.from({ length: 5 }, (_, i) => reply(i));
    const view = render(railFor(thread));
    const rail = screen.getByTestId('rail-thread');
    fixGeometry(rail, 1000, 300);
    // The mount effect ran before geometry was pinned; a re-render with one more
    // message is the first scroll it can measure.
    view.rerender(railFor([...thread, reply(5)]));
    expect(rail.scrollTop).toBe(1000);
    fixGeometry(rail, 1400, 300);
    view.rerender(railFor([...thread, reply(5), reply(6)]));
    expect(rail.scrollTop).toBe(1400);
    expect(screen.queryByTestId('rail-jump')).toBeNull();
  });

  it('stays where the reader scrolled to, counts what arrived below, and the pill jumps back', () => {
    const thread = Array.from({ length: 5 }, (_, i) => reply(i));
    const view = render(railFor(thread));
    const rail = screen.getByTestId('rail-thread');
    fixGeometry(rail, 1000, 300);
    view.rerender(railFor([...thread, reply(5)]));
    expect(rail.scrollTop).toBe(1000);

    // The reader scrolls up to read something older.
    act(() => { rail.scrollTop = 100; fireEvent.scroll(rail); });
    fixGeometry(rail, 1400, 300);
    view.rerender(railFor([...thread, reply(5), reply(6), reply(7)]));
    expect(rail.scrollTop, 'a new message must not yank the reader down').toBe(100);
    const pill = screen.getByTestId('rail-jump');
    expect(pill.textContent).toMatch(/2 new/);

    fireEvent.click(pill);
    expect(rail.scrollTop).toBe(1400);
    expect(screen.queryByTestId('rail-jump')).toBeNull();
  });

  it('scrolling back to the bottom by hand re-pins without the pill', () => {
    const thread = Array.from({ length: 5 }, (_, i) => reply(i));
    const view = render(railFor(thread));
    const rail = screen.getByTestId('rail-thread');
    fixGeometry(rail, 1000, 300);
    view.rerender(railFor([...thread, reply(5)]));
    act(() => { rail.scrollTop = 0; fireEvent.scroll(rail); });
    fixGeometry(rail, 1200, 300);
    view.rerender(railFor([...thread, reply(5), reply(6)]));
    expect(screen.getByTestId('rail-jump')).toBeTruthy();
    // Within a few pixels of the bottom counts as at the bottom.
    act(() => { rail.scrollTop = 1200 - 300 - 8; fireEvent.scroll(rail); });
    expect(screen.queryByTestId('rail-jump')).toBeNull();
    fixGeometry(rail, 1500, 300);
    view.rerender(railFor([...thread, reply(5), reply(6), reply(7)]));
    expect(rail.scrollTop).toBe(1500);
  });
});
