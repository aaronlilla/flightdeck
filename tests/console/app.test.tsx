// @vitest-environment jsdom
import type { Server } from 'node:http';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/console/App.js';
import { createStubServer, resetStubDb, setStubBuild } from '../../src/console/stub-server.js';

class FakeSocket {
  static instances: FakeSocket[] = [];

  onopen: (() => void) | null = null;

  onclose: (() => void) | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;

  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void { this.onclose?.(); }

  send(): void {}
}

let server: Server;
let base: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  resetStubDb();
  server = createStubServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  originalFetch = global.fetch;
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => originalFetch(`${base}${String(input)}`, init)) as typeof fetch;
});

afterEach(async () => {
  global.fetch = originalFetch;
  FakeSocket.instances = [];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('App', () => {
  it('renders the 15-lane board and opens the ticket sheet for a lane', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());
    expect(screen.getAllByText(/FLT-|BBZ-/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('lane-FLT-201'));
    await waitFor(() => expect(screen.getByTestId('ticket-sheet')).toBeInTheDocument());
  });

  it('reloads itself once the server reports a different build than the one it first saw', { timeout: 15000 }, async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      setStubBuild('build-a');
      render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
      await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());
      expect(reload).not.toHaveBeenCalled();
      setStubBuild('build-b');
      // Any feed event triggers a refresh; the refresh reads the new build and reloads
      // instead of rendering the new data with old code.
      FakeSocket.instances[0]?.onmessage?.({ data: JSON.stringify({ type: 'heartbeat', at: Date.now() }) });
      await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 8000 });
    } finally {
      setStubBuild('stub-1');
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('walks board -> answer a parked lane -> receipt card in the rail', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByText('NOT NULL')).toBeInTheDocument());
    await userEvent.click(screen.getByText('NOT NULL'));
    await userEvent.click(screen.getByTestId('question-send'));
    await waitFor(() => expect(screen.getByTestId('rail-thread').textContent).toMatch(/resumed/));
  });

  it('answering a question from the board never echoes a fake operator bubble', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByText('NOT NULL')).toBeInTheDocument());
    await userEvent.click(screen.getByText('NOT NULL'));
    await userEvent.click(screen.getByTestId('question-send'));
    await waitFor(() => expect(screen.getByTestId('rail-thread').textContent).toMatch(/resumed/));
    expect(screen.getByTestId('rail-thread').textContent).not.toMatch(/answer .*NOT NULL/i);
  });

  it('requires a confirm card before a kill goes through', async () => {
    // Irreversible actions no longer show a client-made confirm: `killRun` answers
    // 202 `{ pending: true, token, blast }` and `useAction` turns that into an
    // `ActionOutcomeView` "confirm" card in place, next to the button that was
    // clicked -- nothing runs until that card's own Confirm sends the token back.
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toBeInTheDocument());
    const tile = screen.getByTestId('lane-FLT-204');
    await userEvent.click(within(tile).getByText('Kill attempt'));
    await waitFor(() => expect(within(tile).getByTestId('action-confirm-killRun-FLT-204')).toBeInTheDocument());
    expect(within(tile).getByText(/Confirm, irreversible:/)).toBeInTheDocument();
    await userEvent.click(within(tile).getByTestId('action-confirm-yes-killRun-FLT-204'));
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toHaveAttribute('data-state', 'killed'));
  });

  it('a live event refresh must not silently drop an unconfirmed kill card', async () => {
    // The server-issued confirm now lives in `state.actions` (`useAction`'s own
    // reducer slice), not in `state.thread` -- so the failure mode this guards is no
    // longer a `/thread` replace losing a card the server never echoed back. It is
    // whether a live event's `refresh()`/`refreshSlice('lanes')` -- which fires
    // constantly off the very run about to be killed's `tool.start`/`tool.end` --
    // touches `state.actions` at all. Confirmed live: two attempts on a real run
    // never found (or lost) the card.
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toBeInTheDocument());
    const tile = screen.getByTestId('lane-FLT-204');
    await userEvent.click(within(tile).getByText('Kill attempt'));
    await waitFor(() => expect(within(tile).getByTestId('action-confirm-killRun-FLT-204')).toBeInTheDocument());
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
    FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'tool.start', run: 'FLT-204' }) });
    await waitFor(() => expect(within(screen.getByTestId('lane-FLT-204')).getByTestId('action-confirm-killRun-FLT-204')).toBeInTheDocument());
    await userEvent.click(within(screen.getByTestId('lane-FLT-204')).getByTestId('action-confirm-yes-killRun-FLT-204'));
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toHaveAttribute('data-state', 'killed'));
  });

  it("the operator's own composer text survives a refresh right behind it", async () => {
    // Sweep #2: `refresh()` replaces `state.thread` wholesale from the stub's own
    // `/thread`, which never echoes the operator's typed text back (only the reply
    // cards a command produces) -- so the bubble `onRailSend` appends locally used to
    // vanish the moment the next `/events` frame (or the 5s poll) landed right behind
    // it, sometimes within milliseconds of the operator sending it.
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('rail-thread')).toBeInTheDocument());
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
    await userEvent.type(screen.getByPlaceholderText(/command…/), 'status{Enter}');
    // The command's own reply landing means its round trip (including the `refresh()`
    // right behind it) is done, so a *second*, independent refresh below is the one
    // under test rather than a race with the first.
    await waitFor(() => expect(screen.getByText(/lanes total/)).toBeInTheDocument());
    expect(screen.getByText('status')).toBeInTheDocument();
    FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'tool.start', run: 'FLT-201' }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText('status')).toBeInTheDocument();
  });

  it('delivers a ticket-sheet message to that run, not the board-wide command classifier', async () => {
    // TicketSheet's composer is captioned "message {lane.id}...", so the operator has
    // every reason to believe free text typed there reaches that one run. Wiring it
    // through the same global router the rail composer uses (`onSendLane={(id, text) =>
    // onRailSend(text)}`, discarding `id`) meant an unrecognized message instead earned
    // the canned "I understand: pause, resume, kill..." refusal and reached no run at
    // all -- confirmed live against a real run, whose own thread never showed it.
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('lane-FLT-201'));
    await waitFor(() => expect(screen.getByTestId('ticket-sheet')).toBeInTheDocument());
    const sheet = screen.getByTestId('ticket-sheet');
    const input = within(sheet).getByPlaceholderText(/Tell this run something/);
    await userEvent.type(input, 'status of the migration?');
    await userEvent.click(within(sheet).getByText('Send ⏎'));
    await waitFor(() => expect(screen.getByTestId('ticket-sheet').textContent).toMatch(/status of the migration\?/));
    // The canned command-not-understood reply must never appear: this text went to the
    // run, not to the free-text command classifier.
    expect(screen.queryByText(/I understand: pause, resume, kill/)).not.toBeInTheDocument();
  });

  it('D2.2: answering a question from inside its own ticket sheet resumes the lane, same as answering from the rail', async () => {
    // TicketSheet's own run-thread MessageCard wired `onCommand` to `(text) =>
    // onCommand(lane.id, text)`, which App.tsx routed through the exact-match CTA
    // switch its board tiles use ('kill' | 'merge' | 'watch' | ... | 'reopen'). A
    // question card's own option button sends free text like `answer ask-bbz-118
    // nullable + backfill`, which matches none of those exact strings and fell
    // through with no else branch -- a silent no-op, leaving the lane parked.
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-BBZ-118')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('lane-BBZ-118'));
    await waitFor(() => expect(screen.getByTestId('ticket-sheet')).toBeInTheDocument());
    const sheet = screen.getByTestId('ticket-sheet');
    await userEvent.click(within(sheet).getByText('nullable + backfill', { exact: true }));
    await userEvent.click(within(sheet).getByTestId('question-send'));
    await waitFor(() => expect(screen.getByTestId('lane-BBZ-118')).toHaveAttribute('data-state', 'running'));
  });

  // Item 7: picking a question's option and sending it echoes an operator bubble in
  // the rail reading "Answered: ..." -- the one place answering still needs one.
  it('echoes an "Answered: ..." operator bubble in the rail when a question option is sent', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-BBZ-118')).toBeInTheDocument());
    const rail = screen.getByTestId('rail-thread');
    await userEvent.click(within(rail).getByText('nullable + backfill', { exact: true }));
    await userEvent.click(within(rail).getByTestId('question-send'));
    await waitFor(() => expect(within(rail).getByText(/^Answered: .*nullable \+ backfill/)).toBeInTheDocument());
  });

  it('shows the disconnected banner once the feed drops', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());
    global.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await waitFor(() => expect(screen.getByText(/live feed lost/)).toBeInTheDocument(), { timeout: 15_000 });
  }, 20_000);

  it('D2.1: a 501 refusal card survives the refresh useAction fires right after appending it', async () => {
    // `useAction`'s `settle` appends the refusal card to the rail via `thread-append`,
    // then immediately calls `host.refreshSlices` for the action's effect (`compactRun`
    // is effect `lane`: `['lanes', 'journal']`). Neither of those touches `/thread`, but
    // the failure this guards is unchanged in shape: a client-only card must survive
    // whatever refetch lands right behind it, not get overwritten the moment the next
    // `/thread` read (the 5s poll, or a live event) replaces `state.thread` wholesale.
    // The same failed call also renders inline next to the button that made it, so the
    // assertions below are scoped to the rail to keep the two apart.
    await fetch('/__test/fixture?name=refusal-501', { method: 'POST' });
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    const tile = await screen.findByTestId('lane-FLT-401');
    await userEvent.click(within(tile).getByText('Compact + resume →', { exact: true }));
    const rail = screen.getByTestId('rail-thread');
    await waitFor(() => expect(within(rail).getByText('Refused')).toBeInTheDocument());
    // Give a `/thread` refetch (the 5s poll, or a live event) time to land right behind it.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(within(rail).getByText('Refused')).toBeInTheDocument();
    // `redactErrorBody` folds a `reason` alongside `error` into the text, so a 501
    // carrying both reads as one sentence rather than dropping the reason. Scoped to
    // the rail: the same sentence now also renders on the control and in the toast,
    // more copies on the same screen entirely by design.
    expect(within(rail).getByText('compaction has no successor worker built yet')).toBeInTheDocument();
    expect(tile).toHaveAttribute('data-state', 'exhausted');
  });
});
