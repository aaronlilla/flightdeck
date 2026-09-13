// @vitest-environment jsdom
/**
 * The lane sheet's action bar.
 *
 * A tile carries one button, chosen by the lane's state, so anything the state did not
 * call for could not be clicked at all: a running lane offered no Pause, a finished one
 * no Retire, and nothing anywhere offered a re-audit. Three of those had a server route
 * and a registry entry and no control, so taking a ticket from the queue to a merge meant
 * leaving the console for a terminal.
 *
 * Asserted on which commands are offered and which are refused with a reason, because a
 * button that does nothing on click is the failure this console keeps repeating.
 */
import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const amended = vi.fn(async (_id: string, _text: string) => ({ ok: true }));
const capped = vi.fn(async (_id: string, _cap: number) => ({ ok: true, jid: null, message: 'capped', undoable: true }));

vi.mock('../../src/console/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/console/api.js')>()),
  getRunSummary: async () => ({ what: [], status: '', next: '', audit: null, readiness: null }),
  getRunStory: async () => ({ id: 'r', title: null, kind: 'manual', ticket: null, brief: null, entries: [] }),
  amendRun: (id: string, text: string) => amended(id, text),
  setRunCap: (id: string, cap: number) => capped(id, cap),
}));

import { TicketSheet } from '../../src/console/components/TicketSheet.js';
import { ActionsContext } from '../../src/console/actions.js';
import { initialState, reducer, StoreContext } from '../../src/console/store.js';
import type { Lane } from '../../src/shared/console-model.js';

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

const NOW = Date.parse('2026-09-12T12:00:00Z');
const commanded = vi.fn();

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'r-1', title: 'A real ticket', ticket: 'BBZ-1', state: 'running', kind: 'goal',
    since: NOW - 60_000, pr: null, retiredAt: null, question: null,
    live: { alive: true, pid: 1, lastEventAt: NOW, checkedAt: NOW },
    ...extra,
  } as Lane;
}

function sheet(value: Lane): void {
  render(
    <Wrapper>
      <TicketSheet
        lane={value} now={NOW} onClose={() => {}}
        onCommand={commanded} onSendLane={() => {}}
      />
    </Wrapper>,
  );
}

beforeEach(() => { commanded.mockClear(); amended.mockClear(); capped.mockClear(); });

describe('what the lane sheet lets you do to a lane', () => {
  it('has an action bar at all', () => {
    sheet(lane());
    expect(screen.getByTestId('lane-actions')).toBeTruthy();
  });

  it('offers Pause on a lane that is running', () => {
    sheet(lane());
    expect(screen.getByTestId('lane-do-pause')).toBeTruthy();
  });

  it('sends the command when a button is clicked', () => {
    sheet(lane());
    fireEvent.click(screen.getByTestId('lane-do-pause'));
    expect(commanded).toHaveBeenCalledWith('r-1', 'pause');
  });

  it('does not offer Pause on a lane that is not running, and says why', () => {
    sheet(lane({ state: 'done', live: { alive: false, pid: 1, lastEventAt: NOW, checkedAt: NOW } }));
    expect(screen.queryByTestId('lane-do-pause')).toBeNull();
    expect(screen.getByTestId('lane-actions-unavailable').textContent).toMatch(/Pause — it is done, not running/);
  });

  it('offers Retire once nothing is running, and refuses it while something is', () => {
    sheet(lane({ state: 'done', live: { alive: false, pid: 1, lastEventAt: NOW, checkedAt: NOW } }));
    expect(screen.getByTestId('lane-do-retire')).toBeTruthy();
    cleanup();
    sheet(lane());
    expect(screen.queryByTestId('lane-do-retire')).toBeNull();
    expect(screen.getByTestId('lane-actions-unavailable').textContent).toMatch(/Retire — it is still running/);
  });

  it('offers only Unretire on a lane that has left the board', () => {
    sheet(lane({ retiredAt: NOW - 1000 }));
    expect(screen.getByTestId('lane-do-unretire')).toBeTruthy();
    expect(screen.queryByTestId('lane-do-merge')).toBeNull();
    expect(screen.queryByTestId('lane-do-retire')).toBeNull();
  });

  it('refuses Merge with the reason rather than offering a button that fails', () => {
    sheet(lane({ pr: null }));
    expect(screen.queryByTestId('lane-do-merge')).toBeNull();
    expect(screen.getByTestId('lane-actions-unavailable').textContent).toMatch(/Merge — no pull request is open on it/);
  });

  it('offers Re-audit, which had a route and no control anywhere', () => {
    sheet(lane());
    expect(screen.getByTestId('lane-do-reaudit')).toBeTruthy();
  });
});

describe('steering a lane without stopping it', () => {
  it('adds to the brief, and will not send an empty one', async () => {
    sheet(lane());
    expect(screen.getByTestId('lane-amend-submit').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('lane-amend-input'), { target: { value: '  also fix the header  ' } });
    fireEvent.click(screen.getByTestId('lane-amend-submit'));
    await waitFor(() => { expect(amended).toHaveBeenCalledWith('r-1', 'also fix the header'); });
  });

  it('sets a token ceiling, and refuses one that is not a positive whole number', async () => {
    sheet(lane());
    const box = screen.getByTestId('lane-cap-input');
    const button = screen.getByTestId('lane-cap-submit');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(box, { target: { value: '0' } });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(box, { target: { value: '250000' } });
    fireEvent.click(button);
    await waitFor(() => { expect(capped).toHaveBeenCalledWith('r-1', 250000); });
  });
});

describe('buttons that would do nothing are not offered', () => {
  it('does not offer Unretire on a lane that is still on the board', () => {
    sheet(lane());
    expect(screen.queryByTestId('lane-do-unretire')).toBeNull();
    expect(screen.getByTestId('lane-actions-unavailable').textContent)
      .toMatch(/Unretire — it is already on the board/);
  });

  it('offers Resume on a lane that stopped, and not on one already going', () => {
    sheet(lane({ state: 'paused', live: { alive: false, pid: 1, lastEventAt: NOW, checkedAt: NOW } }));
    expect(screen.getByTestId('lane-do-resume')).toBeTruthy();
    cleanup();
    sheet(lane());
    expect(screen.queryByTestId('lane-do-resume')).toBeNull();
    expect(screen.getByTestId('lane-actions-unavailable').textContent)
      .toMatch(/Resume — it is already running/);
  });
});

describe('the rest of the bar refuses what it cannot do', () => {
  it('offers Compact only while something is running', () => {
    sheet(lane());
    expect(screen.getByTestId('lane-do-compact')).toBeTruthy();
    cleanup();
    sheet(lane({ state: 'done', live: { alive: false, pid: 1, lastEventAt: NOW, checkedAt: NOW } }));
    expect(screen.queryByTestId('lane-do-compact')).toBeNull();
    expect(screen.getByTestId('lane-actions-unavailable').textContent)
      .toMatch(/Compact — nothing is running for it to compact/);
  });
});
