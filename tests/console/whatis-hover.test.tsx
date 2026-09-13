// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WhatIsHover } from '../../src/console/components/WhatIsCard.js';
import type { WhatIs } from '../../src/forge/console/whatis.js';
import { render } from './helpers/with-store.js';

/**
 * Aaron, 2026-09-12: "when i hover over an item that has an acronym, like a bbz ticket
 * number, i should be able to see full detail of the ticket or whatever it is, ticket or
 * not."
 */

const TICKET: WhatIs = {
  kind: 'ticket', ref: 'BBZ-169',
  title: 'Fix player card drop-down persistence across menu navigation',
  state: 'In Progress',
  fields: [{ label: 'Assignee', value: 'Aaron Lilla' }, { label: 'Checks', value: 'success' }],
  body: 'The drop-down loses its selection when the menu is reopened.',
  url: 'https://jira.test/browse/BBZ-169',
};

function mount(answer: WhatIs = TICKET, lookup?: (ref: string) => Promise<WhatIs>) {
  const fn = lookup ?? vi.fn().mockResolvedValue(answer);
  render(<WhatIsHover refText="BBZ-169" lookup={fn}><span>BBZ-169</span></WhatIsHover>);
  return { fn, anchor: screen.getByTestId('whatis-anchor') };
}

describe('hovering an identifier', () => {
  it('shows what it is, without leaving the page', async () => {
    const { anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-card')).toBeTruthy());
    expect(screen.getByTestId('whatis-title').textContent).toContain('drop-down persistence');
    expect(screen.getByTestId('whatis-state').textContent).toBe('In Progress');
    expect(screen.getByTestId('whatis-body').textContent).toContain('loses its selection');
  });

  it('shows every field the answer carried', async () => {
    const { anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-fields')).toBeTruthy());
    const text = screen.getByTestId('whatis-fields').textContent ?? '';
    expect(text).toContain('Aaron Lilla');
    expect(text).toContain('success');
  });

  it('offers a way to open it in full', async () => {
    const { anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-open')).toBeTruthy());
    expect(screen.getByTestId('whatis-open').getAttribute('href')).toBe('https://jira.test/browse/BBZ-169');
  });

  it('asks nothing until the pointer is actually over it', () => {
    const { fn } = mount();
    expect(fn).not.toHaveBeenCalled();
  });

  it('asks once however many times the pointer comes back', async () => {
    const { fn, anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    await userEvent.unhover(anchor);
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-card')).toBeTruthy());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('hides again when the pointer leaves', async () => {
    const { anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-card')).toBeTruthy());
    await userEvent.unhover(anchor);
    await waitFor(() => expect(screen.queryByTestId('whatis-card')).toBeNull());
  });

  it('says so when the reference resolves to nothing, rather than showing a blank card', async () => {
    const nothing: WhatIs = {
      kind: 'unknown', ref: 'BBZ-404', title: null, state: null, fields: [],
      body: 'Nothing on the board or in Jira answers to BBZ-404.', url: null,
    };
    const { anchor } = mount(nothing);
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-body').textContent).toContain('Nothing on the board'));
  });

  it('stays quiet when the server cannot be reached, rather than covering the text with an error', async () => {
    const { anchor } = mount(TICKET, vi.fn().mockRejectedValue(new Error('offline')));
    await userEvent.hover(anchor);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByTestId('whatis-card')).toBeNull();
  });

  it('opens on keyboard focus too, so it is not a pointer-only feature', async () => {
    const { anchor } = mount();
    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await waitFor(() => expect(screen.getByTestId('whatis-card')).toBeTruthy());
  });
});

/**
 * The escape this covers, found by looking at it on 2026-09-12: every test above was
 * green while the card rendered about 140px wide inside a board column, wrapping the
 * state one letter per line. An absolutely positioned box takes its width from its
 * containing block, and the anchor sits in a narrow column.
 *
 * This asserts the card declares its own width rather than inheriting one. It is a
 * PROXY and says so: jsdom does no layout, so nothing here can measure a rendered box.
 * The real check is a person looking, and the screenshot that found this is why. What
 * this stops is the specific regression — somebody removing the width declaration.
 */
describe('the card carries its own width', () => {
  it('does not inherit the width of whatever column it opened in', async () => {
    const { anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-card')).toBeTruthy());
    const style = screen.getByTestId('whatis-card').getAttribute('style') ?? '';
    expect(style, 'the card must declare a width of its own').toMatch(/min-width/);
    expect(style).toMatch(/max-width/);
  });
});

/**
 * Two more escapes from the same feature, both found by screenshotting it and both
 * invisible to every test above.
 *
 * The card was drawn beside its anchor, and the Needs-you strip scrolls inside itself
 * (`maxHeight: 34vh; overflow-y: auto`) — so it rendered at the right size and position
 * and was clipped out of sight. Then, drawn into the body to escape that, it lost the
 * colour variables, which live on the app's own div: it came back solid-sized and fully
 * transparent, with the page showing through it.
 */
describe('the card escapes whatever it opened inside', () => {
  it('is drawn into the document body, not beside its anchor', async () => {
    const { anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-card')).toBeTruthy());
    expect(screen.getByTestId('whatis-card').parentElement?.tagName).toBe('BODY');
  });

  it('is positioned against the viewport, since its anchor is no longer its parent', async () => {
    const { anchor } = mount();
    await userEvent.hover(anchor);
    await waitFor(() => expect(screen.getByTestId('whatis-card')).toBeTruthy());
    expect(screen.getByTestId('whatis-card').getAttribute('style') ?? '').toMatch(/position:\s*fixed/);
  });
});

/**
 * Aaron, 2026-09-12: "when hovering the ticket it will close if you try to move the mouse
 * to it because the area is too little."
 *
 * The card is drawn into the document body so a scrolling ancestor cannot clip it, which
 * means it is NOT a descendant of its anchor: the browser fires `mouseleave` on the anchor
 * the instant the pointer starts travelling toward the card, and there is a gap to cross.
 * So the close waits, and arriving on the card cancels it.
 */
describe('reaching the card with the pointer', () => {
  /**
   * Real timers here would let a React state change land in a timer callback that
   * testing-library never flushes, so the card stays in the DOM after it has logically
   * closed — and the case passes with the fix removed. Proven: neutering the card's own
   * `onMouseEnter` left the first version of these green. Fake timers plus `act` make
   * both the timing and the flush explicit.
   */
  async function openCard() {
    const { anchor } = mount();
    await act(async () => { fireEvent.mouseEnter(anchor); });
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('whatis-card')).toBeTruthy();
    return anchor;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not close the instant the pointer starts travelling toward it', async () => {
    const anchor = await openCard();
    await act(async () => { fireEvent.mouseLeave(anchor); });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(screen.queryByTestId('whatis-card'), 'it closed before the pointer could arrive').toBeTruthy();
  });

  it('stays up once the pointer arrives on it', async () => {
    const anchor = await openCard();
    await act(async () => { fireEvent.mouseLeave(anchor); });
    await act(async () => { fireEvent.mouseEnter(screen.getByTestId('whatis-card')); });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByTestId('whatis-card'), 'it closed while the pointer was on it').toBeTruthy();
  });

  it('closes once the pointer leaves the card as well', async () => {
    const anchor = await openCard();
    await act(async () => { fireEvent.mouseLeave(anchor); });
    await act(async () => { fireEvent.mouseEnter(screen.getByTestId('whatis-card')); });
    await act(async () => { fireEvent.mouseLeave(screen.getByTestId('whatis-card')); });
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByTestId('whatis-card')).toBeNull();
  });
});
