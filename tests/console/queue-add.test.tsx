// @vitest-environment jsdom
/**
 * The queue's Add box.
 *
 * Before it, the queue screen held a width stepper and nothing else: there was no control
 * anywhere in the console that put work into the queue, so a ticket could not be taken
 * end to end through the console at all. The rail's own tool was the only route in.
 *
 * Asserted on what reaches the server, like its siblings: the reading shown under the box
 * and the body sent are the two things a wrong control gets wrong.
 */
import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const added = vi.fn(async () => ({ ok: true, items: [] }));

vi.mock('../../src/console/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/console/api.js')>()),
  addToQueue: (body: unknown) => added(body),
}));

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

function view(): void {
  render(<Wrapper><QueueView items={[]} paused={false} maxInFlight={4} working={0} /></Wrapper>);
}

beforeEach(() => { added.mockClear(); });

describe('putting work into the queue from the queue screen', () => {
  it('is there at all', () => {
    view();
    expect(screen.getByTestId('queue-add-input')).toBeTruthy();
    expect(screen.getByTestId('queue-add-submit')).toBeTruthy();
  });

  it('will not send an empty box', () => {
    view();
    expect(screen.getByTestId('queue-add-submit').hasAttribute('disabled')).toBe(true);
  });

  it('says what it made of a ticket key before anything is sent', () => {
    view();
    fireEvent.change(screen.getByTestId('queue-add-input'), { target: { value: 'bbz-289' } });
    expect(screen.getByTestId('queue-add-reading').textContent).toBe('Reads as the ticket BBZ-289.');
  });

  it('sends a ticket key as a ticket, upper-cased', async () => {
    view();
    fireEvent.change(screen.getByTestId('queue-add-input'), { target: { value: 'bbz-289' } });
    fireEvent.click(screen.getByTestId('queue-add-submit'));
    await waitFor(() => {
      expect(added).toHaveBeenCalledWith({ source: 'ticket', input: 'BBZ-289' });
    });
  });

  it('sends a sentence as a brief, whole', async () => {
    view();
    const text = 'The wallet balance is stale after a second visit';
    fireEvent.change(screen.getByTestId('queue-add-input'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('queue-add-submit'));
    await waitFor(() => {
      expect(added).toHaveBeenCalledWith({ source: 'brief', input: text });
    });
  });

  it('sends on Enter, and keeps Shift+Enter for a brief that wants its own lines', async () => {
    view();
    const box = screen.getByTestId('queue-add-input');
    fireEvent.change(box, { target: { value: 'BBZ-1' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(added).not.toHaveBeenCalledWith({ source: 'ticket', input: 'BBZ-1' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(added).toHaveBeenCalledWith({ source: 'ticket', input: 'BBZ-1' });
    });
  });
});
