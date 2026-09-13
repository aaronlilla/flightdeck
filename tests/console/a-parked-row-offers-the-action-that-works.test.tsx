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

/**
 * Recovery has a budget, and a spent budget is a person's call.
 *
 * The queue caps automatic recovery at three attempts and says so plainly when it gives
 * up: "recovered 3 times already and parked again; a person needs to read this one"
 * (live, 2026-09-13). The row went on offering Retry anyway -- the one thing the queue had
 * already decided would not work, offered to the person it had just handed the item to.
 *
 * The reason's own classification is separate and still holds: a re-readable reason with
 * budget left keeps Retry. This is about the budget, not the reason.
 */
describe('a park whose recovery budget is spent', () => {
  function tried(id: string, attempts: number): QueueItem {
    return { ...parked(id, 'run finished done but no PR was found in its evidence or on its branch'), recoveryAttempts: attempts } as QueueItem;
  }

  it('offers Remove once the queue has given up on it', () => {
    show([tried('Q-6', 3)]);
    expect(controlsOn('Q-6'), 'the queue already said a person has to read this one').toEqual(['Remove']);
  });

  it('still offers Retry while there is budget left', () => {
    show([tried('Q-7', 2)]);
    expect(controlsOn('Q-7')).toEqual(['Retry']);
  });

  it('offers Retry on one nothing has tried yet', () => {
    show([tried('Q-8', 0)]);
    expect(controlsOn('Q-8')).toEqual(['Retry']);
  });

  it('treats a missing count as untried rather than as spent', () => {
    show([parked('Q-9', 'checks are pending')]);
    expect(controlsOn('Q-9')).toEqual(['Retry']);
  });

  it('is still exactly one control', () => {
    show([tried('Q-10', 5)]);
    expect(controlsOn('Q-10')).toHaveLength(1);
  });
});
