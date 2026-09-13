// @vitest-environment jsdom
/**
 * The board's two sweeps.
 *
 * Merging everything ready meant clicking Merge once per lane, and clearing the finished
 * lanes off the board had no route through the console at all -- both had a server route
 * and a registry entry and no button. Neither can be undone, so each asks first.
 */
import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mergedReady = vi.fn(async (_confirm?: string) => ({ ok: true, jid: null, message: 'merged', undoable: false }));
const retiredFinished = vi.fn(async (_confirm?: string) => ({ ok: true, jid: null, message: 'cleared', undoable: false }));

vi.mock('../../src/console/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/console/api.js')>()),
  postMergeReady: (confirm?: string) => mergedReady(confirm),
  postRetireFinished: (confirm?: string) => retiredFinished(confirm),
}));

import { LanesGrid } from '../../src/console/components/LanesGrid.js';
import { ActionsContext } from '../../src/console/actions.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';
import type { Lane } from '../../src/shared/console-model.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');

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

function board(lanes: Lane[]): void {
  render(
    <Wrapper>
      <LanesGrid
        lanes={lanes} blockers={[]} now={NOW}
        queue={{ items: [], paused: false, pauseReason: null, maxInFlight: 4, on: true }}
        onOpen={() => {}} onCommand={() => {}} onLaneCommand={() => {}} onQueue={() => {}}
      />
    </Wrapper>,
  );
}

beforeEach(() => { mergedReady.mockClear(); retiredFinished.mockClear(); });

describe('clearing the board in one go', () => {
  it('offers both sweeps', () => {
    board([]);
    expect(screen.getByTestId('board-merge-ready')).toBeTruthy();
    expect(screen.getByTestId('board-retire-finished')).toBeTruthy();
  });

  it('will not offer a merge sweep with nothing ready to merge', () => {
    board([]);
    const button = screen.getByTestId('board-merge-ready');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toBe('Merge all 0 ready');
  });

  it('asks before it clears the finished lanes, because that cannot be undone', async () => {
    board([]);
    fireEvent.click(screen.getByTestId('board-retire-finished'));
    await waitFor(() => { expect(retiredFinished).toHaveBeenCalled(); });
  });
});
