// @vitest-environment jsdom
/**
 * `titleOf` used to fall back to `item.ticket` when a queue item's title had not been
 * read yet. The ticket key is already rendered in the span right beside it
 * (`WhatIsHover` + `.key`), so a queued item with a null title printed the key twice --
 * a row read 'BBZ-289 BBZ-289'. Asserts the fallback text instead, and that a row never
 * repeats the same string.
 */
import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QueueView } from '../../src/console/components/QueueView.js';
import { ActionsContext } from '../../src/console/actions.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <ActionsContext.Provider value={{ refreshSlices: () => undefined, follow: () => undefined, release: () => undefined }}>
        {children}
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}

function viewWith(items: unknown[]): void {
  render(<Wrapper><QueueView items={items as never} paused={false} maxInFlight={4} working={0} /></Wrapper>);
}

const unread = {
  id: 'q-1', source: 'ticket' as const, state: 'queued' as const, ticket: 'BBZ-289',
  title: null, addedAt: 1, whyNext: 'next up', startsIn: 'now',
};

describe('a queue row whose title has not been read yet', () => {
  it('says so in plain words, instead of repeating the ticket key', () => {
    viewWith([unread]);
    expect(screen.getByTestId('queue-title-glance').textContent).toBe('Title not read yet');
  });

  it('never prints the same string twice on one row', () => {
    viewWith([unread]);
    const row = screen.getByTestId('queue-row-q-1');
    const key = row.querySelector('.key')?.textContent ?? '';
    const title = screen.getByTestId('queue-title-glance').textContent ?? '';
    expect(key.length).toBeGreaterThan(0);
    expect(title).not.toBe(key);
  });
});
