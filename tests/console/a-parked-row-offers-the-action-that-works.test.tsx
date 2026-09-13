// @vitest-environment jsdom
/**
 * A parked queue row offers the one action that can do something.
 *
 * Measured on the live queue, 2026-09-13: fifteen parked rows, nine of them parked on
 * "BBZ-nnn already has a merged pull request", and every one of them offering Retry.
 * Retry re-plans the item, the planner finds the pull request again, and it parks on the
 * same sentence three seconds later -- the ten-minute loop fixed the same day. The single
 * control those rows carried was the only one that could not work, and the action a person
 * wanted (drop it, the work has shipped) was on no screen at all. Clearing one meant a
 * terminal.
 *
 * `ux-one-action-per-state.test.tsx` allows a queue row exactly one control, and that rule
 * is not overturned here: the row still shows one. It shows the right one. A park a
 * machine can recover from keeps Retry; a park that is a person's call gets Remove.
 */
import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QueueView } from '../../src/console/components/QueueView.js';
import { ActionsContext } from '../../src/console/actions.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';
import type { QueueItem } from '../../src/shared/console-model.js';

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

function parked(id: string, reason: string): QueueItem {
  return {
    id, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', title: 'A ticket', repo: 'owner/name',
    briefPath: null, branch: null, worktreePath: null, base: null,
    state: 'parked', reason, runKey: null, pr: null, journalIds: [], createdAt: 1, updatedAt: 1,
  } as unknown as QueueItem;
}

function show(items: QueueItem[]): void {
  render(<Wrapper><QueueView items={items as never} paused={false} maxInFlight={4} working={0} /></Wrapper>);
}

function controlsOn(id: string): string[] {
  const row = document.querySelector(`[data-testid="queue-later-${id}"]`);
  return [...(row?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim());
}

describe('the control on a parked row', () => {
  it('is Remove when nothing a machine does can change the park', () => {
    show([parked('Q-1', 'ABC-1 already has a merged pull request: https://x/pull/9')]);
    expect(controlsOn('Q-1'), 'Retry cannot change a pull request that exists').toEqual(['Remove']);
  });

  it('is still Retry when the park is something a re-read can settle', () => {
    show([parked('Q-2', 'checks are pending')]);
    expect(controlsOn('Q-2')).toEqual(['Retry']);
  });

  it('is exactly one control either way, which is the rule this must not break', () => {
    show([
      parked('Q-3', 'ABC-1 already has an open pull request: https://x/pull/9'),
      parked('Q-4', 'checks never settled'),
    ]);
    expect(controlsOn('Q-3')).toHaveLength(1);
    expect(controlsOn('Q-4')).toHaveLength(1);
  });

  for (const reason of [
    'backend: somebody has to answer this',
    'conflicts with another branch',
    'unrouted',
    'exhausted',
  ]) {
    it(`offers Remove for a park a person has to settle (${reason.slice(0, 24)})`, () => {
      show([parked('Q-5', reason)]);
      expect(controlsOn('Q-5')).toEqual(['Remove']);
    });
  }
});
