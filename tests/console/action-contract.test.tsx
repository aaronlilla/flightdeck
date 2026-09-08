// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The four promises `useAction` makes, checked once per catalog entry rather than once
 * per screen. Every entry in `ACTIONS` is driven through a real `ActionButton` and has
 * to show, in order:
 *
 * 1. pending within one render, with the control refusing further clicks;
 * 2. the answer beside the control, in the server's own words;
 * 3. the same answer in the rail as a receipt;
 * 4. a link to where the effect can be seen, and a refetch of the slices it made stale.
 *
 * An entry marked `reversible: false` gets a fifth: the call runs nothing until the
 * server-issued token goes back, and a declined confirm releases it and calls nothing.
 *
 * The fixture table is checked against the catalog, so a new action cannot be added
 * without a case here; what each action is called and whether it can be undone is
 * checked by `actions-catalog.test.ts` against `api.ts` itself.
 */
import type { JSX, ReactNode } from 'react';
import { useReducer } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/console/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/console/api.js')>();
  return { ...actual };
});

import * as api from '../../src/console/api.js';
import { ACTIONS, ACTION_LIST, EFFECT_SLICES, ActionsContext, type ActionSpec } from '../../src/console/actions.js';
import { ActionButton } from '../../src/console/components/ActionButton.js';
import { initialState, reducer, StoreContext, type ActionLink } from '../../src/console/store.js';
import type { Message } from '../../src/shared/console-model.js';

interface Case {
  /** What the control is clicked with. */
  args: any[];
  /** What `api.<id>` resolves to once the call is allowed to run. */
  result: any;
  /** The sentence the control and the rail must both carry. */
  text: string;
}

const OK = { ok: true, message: 'the server said so', jid: 'J-1' };

/** The gated answer an irreversible route gives before the token comes back. */
const PENDING = { ok: false, pending: true, token: 'T-9', blast: '2 lanes', card: { k: 'c', type: 'confirm', text: 'confirm?', ts: 0, source: 'console' } };

const CASES: Record<string, Case> = {
  recheckRun: { args: ['L-1'], result: { next: 'ready to merge' }, text: 're-checked: ready to merge' },
  reauditRun: { args: ['L-1'], result: { started: true }, text: 'audit started; the result lands as a new attestation' },
  postRetireFinished: { args: [], result: { ...OK, message: 'retired 2 lanes', retired: ['L-1', 'L-2'] }, text: 'retired 2 lanes' },
  postMergeReady: { args: [], result: { ...OK, message: 'merged 1 lane', outcomes: [] }, text: 'merged 1 lane' },
  resolveBlocker: { args: ['aws'], result: { ok: true, started: ['L-1'], lastCheck: null }, text: 'resolved, restarted L-1' },
  checkBlocker: { args: ['aws'], result: { ok: true, started: [], lastCheck: null }, text: 'clear' },
  killRun: { args: ['L-1', 'operator'], result: { ...OK, message: 'killed L-1' }, text: 'killed L-1' },
  stopAll: { args: [], result: { ...OK, message: 'stopped 2 runs', stopped: ['L-1', 'L-2'] }, text: 'stopped 2 runs' },
  retireRun: { args: ['L-1'], result: { ...OK, message: 'retired L-1' }, text: 'retired L-1' },
  pauseRun: { args: ['L-1'], result: { ...OK, message: 'paused L-1' }, text: 'paused L-1' },
  resumeRun: { args: ['L-1'], result: { ...OK, message: 'resumed L-1' }, text: 'resumed L-1' },
  mergeRun: { args: ['L-1'], result: { ...OK, message: 'merged L-1' }, text: 'merged L-1' },
  reopenRun: { args: ['L-1'], result: { ...OK, message: 'reopened L-1' }, text: 'reopened L-1' },
  unretireRun: { args: ['L-1'], result: { ...OK, message: 'L-1 is back on the board' }, text: 'L-1 is back on the board' },
  compactRun: { args: ['L-1'], result: { ...OK, message: 'compacted L-1' }, text: 'compacted L-1' },
  verifyRun: { args: ['L-1'], result: { ...OK, message: 'verify started' }, text: 'verify started' },
  setRunCap: { args: ['L-1', 5_000_000], result: { ...OK, message: 'cap set to 5,000,000' }, text: 'cap set to 5,000,000' },
  amendRun: { args: ['L-1', 'also update the note'], result: { ...OK, message: 'brief amended' }, text: 'brief amended' },
  setCaps: { args: [{ dailyTokens: 10 }], result: { dailyTokens: 10, runTokens: 5 }, text: 'caps saved' },
  sendCommand: { args: ['what is stuck', undefined], result: { cards: [{ k: 'r', type: 'receipt', text: 'two lanes are waiting on you', ts: 0, source: 'conductor' }] }, text: 'two lanes are waiting on you' },
  checkIntegration: { args: ['aws'], result: { items: [{ id: 'aws', name: 'AWS', status: 'connected', latencyMs: 12 }] }, text: 'AWS is connected (12 ms)' },
  reconnectIntegration: { args: ['aws'], result: { ok: true, message: 'aws sso login finished', jid: 'J-1' }, text: 'aws sso login finished' },
  applyProposal: { args: ['P-1'], result: { ...OK, message: 'rule applied' }, text: 'rule applied' },
  dismissProposal: { args: ['P-1'], result: { ...OK, message: 'proposal dismissed' }, text: 'proposal dismissed' },
  restoreProposal: { args: ['P-1'], result: { ...OK, message: 'proposal restored' }, text: 'proposal restored' },
  undoJournal: { args: ['J-7'], result: { ...OK, message: 'undone' }, text: 'undone' },
  dismissAsk: { args: ['ask-L-1'], result: { ...OK, message: 'question cleared' }, text: 'question cleared' },
  addToQueue: { args: [{ source: 'ticket', input: 'ABC-9' }], result: { ok: true, items: [{ id: 'Q-1' }] }, text: 'added 1 item to the queue' },
  removeQueueItem: { args: ['Q-1'], result: { ...OK, message: 'Q-1 removed' }, text: 'Q-1 removed' },
  retryQueueItem: { args: ['Q-1'], result: { ...OK, message: 'Q-1 requeued' }, text: 'Q-1 requeued' },
  pauseQueue: { args: [], result: { ...OK, message: 'queue paused' }, text: 'queue paused' },
  resumeQueue: { args: [], result: { ...OK, message: 'queue resumed' }, text: 'queue resumed' },
  postQueueWidth: { args: [12], result: { ...OK, message: 'queue width set to 12' }, text: 'queue width set to 12' },
  mergeQueueItem: { args: ['Q-1'], result: { ...OK, message: 'Q-1 merged' }, text: 'Q-1 merged' },
  promoteQueueItem: { args: ['Q-1', '1.3.0', 'hotfix'], result: { ...OK, message: 'Q-1 promoted' }, text: 'Q-1 promoted' },
};

/** What the page around the control does, captured rather than performed. */
const refreshed: string[][] = [];
const followed: ActionLink[] = [];
const released: string[] = [];

let receipts: Message[] = [];

function Harness({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  receipts = state.localCards;
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <ActionsContext.Provider value={{
        refreshSlices: (slices) => refreshed.push([...slices]),
        follow: (link) => followed.push(link),
        release: (token) => released.push(token),
      }}
      >
        {children}
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}

/** A promise the test decides when to settle, so "pending within one render" is a
 *  fact about the render and not about how fast the machine is. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mockOf(spec: ActionSpec<any, any>): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  (api as any)[spec.id] = fn;
  return fn;
}

beforeEach(() => {
  refreshed.length = 0;
  followed.length = 0;
  released.length = 0;
  receipts = [];
});

afterEach(() => { vi.restoreAllMocks(); });

describe('the fixture table', () => {
  it('has a case for every catalog entry and none for anything else', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(ACTIONS).sort());
  });
});

describe.each(ACTION_LIST.map((spec) => [spec.id, spec] as const))('%s', (id, spec) => {
  const fixture = CASES[id] as Case;

  it('is pending within one render and takes no second click while in flight', async () => {
    const gate = deferred<any>();
    const call = mockOf(spec);
    call.mockReturnValue(gate.promise);
    render(<Harness><ActionButton spec={spec} args={fixture.args} /></Harness>);
    const button = document.querySelector(`[data-testid^="action-${id}"]`) as HTMLElement;
    expect(button.dataset['pending']).toBe('false');
    fireEvent.click(button);
    expect(button.dataset['pending']).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve(spec.reversible === false ? { ...PENDING } : fixture.result); });
  });

  it('shows the answer where it was clicked, receipts it in the rail and offers the link', async () => {
    const call = mockOf(spec);
    call.mockResolvedValue(fixture.result);
    render(<Harness><ActionButton spec={spec} args={fixture.args} /></Harness>);
    const button = document.querySelector(`[data-testid^="action-${id}"]`) as HTMLElement;
    await act(async () => { fireEvent.click(button); });
    const result = await waitFor(() => document.querySelector(`[data-testid^="action-result-${id}"]`) as HTMLElement);
    expect(result.textContent).toContain(fixture.text);
    expect(result.getAttribute('data-ok')).toBe('true');

    if (spec.railReceipt === false) {
      expect(receipts).toHaveLength(0);
    } else {
      expect(receipts.map((card) => card.text)).toContain(fixture.text);
      expect(receipts.every((card) => card.type === 'receipt')).toBe(true);
    }

    const link = spec.link ? spec.link(fixture.args, fixture.result) : null;
    if (link) {
      const anchor = document.querySelector(`[data-testid^="action-link-${id}"]`) as HTMLElement;
      expect(anchor, `${id} promises a link`).not.toBeNull();
      expect(anchor.textContent).toContain(link.label);
      fireEvent.click(anchor);
      expect(followed).toContainEqual(link);
    }

    expect(refreshed).toContainEqual([...EFFECT_SLICES[spec.effect]]);
  });

  it('shows the server error verbatim and does not swallow it', async () => {
    const call = mockOf(spec);
    call.mockRejectedValue(new api.ApiError(409, 'the branch is gone'));
    render(<Harness><ActionButton spec={spec} args={fixture.args} /></Harness>);
    const button = document.querySelector(`[data-testid^="action-${id}"]`) as HTMLElement;
    await act(async () => { fireEvent.click(button); });
    const result = await waitFor(() => document.querySelector(`[data-testid^="action-result-${id}"]`) as HTMLElement);
    expect(result.textContent).toContain('the branch is gone');
    expect(result.getAttribute('data-ok')).toBe('false');
    // A failure is still a receipt, marked as a refusal rather than a success.
    if (spec.railReceipt !== false) expect(receipts.map((card) => card.type)).toContain('refusal');
  });
});

describe.each(ACTION_LIST.filter((spec) => spec.reversible === false).map((spec) => [spec.id, spec] as const))(
  '%s runs nothing before the server-issued confirm',
  (id, spec) => {
    const fixture = CASES[id] as Case;

    it('asks first, then runs with the token the server issued', async () => {
      const call = mockOf(spec);
      call.mockResolvedValueOnce({ ...PENDING }).mockResolvedValueOnce(fixture.result);
      render(<Harness><ActionButton spec={spec} args={fixture.args} /></Harness>);
      const button = document.querySelector(`[data-testid^="action-${id}"]`) as HTMLElement;
      await act(async () => { fireEvent.click(button); });

      const card = await waitFor(() => document.querySelector(`[data-testid^="action-confirm-${id}"]`) as HTMLElement);
      expect(card.textContent).toContain('2 lanes');
      // Nothing has run: the one call so far carried no token.
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0]?.at(-1)).not.toBe('T-9');
      expect(receipts).toHaveLength(0);

      const yes = document.querySelector(`[data-testid^="action-confirm-yes-${id}"]`) as HTMLElement;
      await act(async () => { fireEvent.click(yes); });
      await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
      expect(call.mock.calls[1]?.at(-1)).toBe('T-9');
      const result = await waitFor(() => document.querySelector(`[data-testid^="action-result-${id}"]`) as HTMLElement);
      expect(result.textContent).toContain(fixture.text);
    });

    it('declining releases the server-side pending entry and calls nothing more', async () => {
      const call = mockOf(spec);
      call.mockResolvedValue({ ...PENDING });
      render(<Harness><ActionButton spec={spec} args={fixture.args} /></Harness>);
      const button = document.querySelector(`[data-testid^="action-${id}"]`) as HTMLElement;
      await act(async () => { fireEvent.click(button); });
      const no = await waitFor(() => document.querySelector(`[data-testid^="action-confirm-no-${id}"]`) as HTMLElement);
      await act(async () => { fireEvent.click(no); });
      expect(call).toHaveBeenCalledTimes(1);
      expect(released).toContain('T-9');
      expect(document.querySelector(`[data-testid^="action-confirm-${id}"]`)).toBeNull();
    });
  },
);
