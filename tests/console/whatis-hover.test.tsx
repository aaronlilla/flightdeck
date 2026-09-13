// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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
