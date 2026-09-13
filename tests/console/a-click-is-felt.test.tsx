// @vitest-environment jsdom
/**
 * Every control says so the moment it is pressed.
 *
 * Aaron, 2026-09-13: "if i click a button anywhere in the application i expect to feel
 * immediate feedback". Four places render a lane command -- the board tile, the
 * waiting-for-merge row, the blocked row, and the lane sheet's action bar -- and each one
 * called through and rendered nothing at all. The click sat there looking unpressed until
 * the next poll changed the row underneath it, which on a merge is several seconds of
 * wondering whether the button works.
 *
 * The pending state was already dispatched on every call, keyed by the action and the
 * lane. Nothing on the board read it. These assert the read, and that the table mapping a
 * command to its action agrees with the dispatch that runs it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/console/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/console/api.js')>()),
  // Never settles, so the pending state stays up for the assertion -- which is the state
  // a person is looking at while a real merge runs.
  // Never settles, so the pending state stays up for the assertion -- which is the state
  // a person is looking at while a real merge runs.
  mergeRun: (_id: string, confirm?: string) => (confirm === undefined && MERGE_PROPOSES
    ? Promise.resolve({ pending: true, token: 'tok-merge', blast: 'merges it' })
    : new Promise(() => {})),
  isConfirmPending: (r: unknown) => typeof r === 'object' && r !== null && 'pending' in r,
}));

/** Flipped per test: a merge that hangs (for the busy assertions) or one that answers with
 *  a proposal (for the confirm assertions). */
let MERGE_PROPOSES = false;

import { LaneTile } from '../../src/console/components/LaneTile.js';
import { ACTIONS, ActionsContext, useAction } from '../../src/console/actions.js';
import { actionForCommand } from '../../src/console/commandPending.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';
import type { Lane } from '../../src/shared/console-model.js';
import type { BoardCommand } from '../../src/console/laneVM.js';

const NOW = Date.parse('2026-09-13T12:00:00Z');

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'r-1', title: 'A real ticket', ticket: 'BBZ-1', state: 'done', kind: 'goal',
    since: NOW - 60_000, retiredAt: null, question: null,
    now: 'Ready to merge.', plain: 'Ready to merge.', stepText: '', did: '', you: '',
    repo: 'owner/name',
    live: { alive: false, pid: 1, lastEventAt: NOW, checkedAt: NOW },
    pr: { no: 7, url: 'https://example.test/7', merged: false, draft: false },
    mergeable: { ok: true },
    ...extra,
  } as Lane;
}

/** Renders the tile beside a button that starts the same action the board dispatches, so
 *  the pending state under test is the real one rather than a hand-set flag. */
function Harness({ value }: { value: Lane }): JSX.Element {
  const merge = useAction(ACTIONS.mergeRun, value.id);
  return (
    <>
      <button type="button" data-testid="start" onClick={() => { void merge.run(value.id); }}>start</button>
      <LaneTile lane={value} now={NOW} onOpen={() => {}} onCommand={() => {}} />
    </>
  );
}

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

describe('a click on the board', () => {
  it('leaves the button idle until something is in flight', () => {
    render(<Wrapper><Harness value={lane()} /></Wrapper>);
    const button = screen.getByTestId('primary-action');
    expect(button.textContent).toBe('Merge');
    expect(button.getAttribute('aria-busy')).toBe('false');
  });

  it('says so the moment the action starts, without waiting for a poll', async () => {
    MERGE_PROPOSES = false;
    render(<Wrapper><Harness value={lane()} /></Wrapper>);
    fireEvent.click(screen.getByTestId('start'));
    await waitFor(() => {
      const button = screen.getByTestId('primary-action');
      expect(button.textContent, 'the button still reads idle while the merge runs').toBe('Merging…');
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.hasAttribute('disabled'), 'it can be pressed twice').toBe(true);
    });
  });
});

describe('the table from a command to the action it runs', () => {
  // The dispatch and this table are two lists of the same thing, and a command missing
  // from the table shows no feedback while looking exactly like one that does.
  const APP = readFileSync(join(process.cwd(), 'src', 'console', 'App.tsx'), 'utf8');

  it('names an action for every command the board dispatches one for', () => {
    const dispatched = [...APP.matchAll(/case '([a-z-]+)': void runCatalogAction\(ACTIONS\.(\w+)/g)]
      .map((m) => ({ cmd: m[1] as BoardCommand, action: m[2]! }));
    expect(dispatched.length, 'the dispatch was not found to read').toBeGreaterThan(8);
    for (const { cmd, action } of dispatched) {
      expect(actionForCommand(cmd), `${cmd} shows no feedback`).toBe(action);
    }
  });

  it('claims no action for a command that only navigates', () => {
    for (const cmd of ['settings', 'queue', 'blockers', 'watch', 'answer'] as BoardCommand[]) {
      expect(actionForCommand(cmd), `${cmd} would show a busy state for nothing`).toBeNull();
    }
  });
});

describe('an irreversible command', () => {
  it('asks on the button that was pressed, and sends the token on the second press', async () => {
    MERGE_PROPOSES = true;
    const sent: string[] = [];
    function Confirming(): JSX.Element {
      const merge = useAction(ACTIONS.mergeRun, 'r-1');
      return (
        <>
          <button type="button" data-testid="start" onClick={() => { void merge.run('r-1'); }}>start</button>
          <LaneTile lane={lane()} now={NOW} onOpen={() => {}} onCommand={(_id, cmd) => { sent.push(cmd); }} />
        </>
      );
    }
    render(<Wrapper><Confirming /></Wrapper>);
    expect(screen.getByTestId('primary-action').textContent).toBe('Merge');

    fireEvent.click(screen.getByTestId('start'));
    await waitFor(() => {
      // The proposal used to land only in the rail, leaving this button reading "Merge"
      // while the question was somewhere else on the screen.
      expect(screen.getByTestId('primary-action').textContent).toBe('Confirm merge');
    });

    fireEvent.click(screen.getByTestId('primary-action'));
    expect(sent, 'the second press re-proposed instead of confirming').toEqual(['confirm:tok-merge']);
  });
});
