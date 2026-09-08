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
    await waitFor(() => expect(screen.getByTestId('rail-thread').textContent).toMatch(/resumed/));
  });

  it('answering a question from the board never echoes a fake operator bubble', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByText('NOT NULL')).toBeInTheDocument());
    await userEvent.click(screen.getByText('NOT NULL'));
    await waitFor(() => expect(screen.getByTestId('rail-thread').textContent).toMatch(/resumed/));
    expect(screen.getByTestId('rail-thread').textContent).not.toMatch(/answer .*NOT NULL/i);
  });

  it('requires a confirm card before a kill goes through', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toBeInTheDocument());
    await userEvent.click(within(screen.getByTestId('lane-FLT-204')).getByText('Kill attempt'));
    expect(screen.getByText('Confirm — irreversible')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toHaveAttribute('data-state', 'killed'));
  });

  it('a live event refresh must not silently drop an unconfirmed kill card', async () => {
    // The Kill/Merge confirm card is client-only state until Confirm is clicked. `/events`
    // fires on every journal event from every lane -- including the very run about to be
    // killed, which produces `tool.start`/`tool.end` several times a minute -- and each
    // frame makes App refetch `/thread`, which this stub answers from its fixed seed and
    // therefore never echoes back a card the operator has not confirmed yet. Confirmed
    // live: two attempts on a real run never found (or lost) the card at all.
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toBeInTheDocument());
    await userEvent.click(within(screen.getByTestId('lane-FLT-204')).getByText('Kill attempt'));
    expect(screen.getByText('Confirm — irreversible')).toBeInTheDocument();
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
    FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'tool.start', run: 'FLT-204' }) });
    await waitFor(() => expect(screen.getByText('Confirm — irreversible')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toHaveAttribute('data-state', 'killed'));
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
    const input = within(sheet).getByPlaceholderText('message FLT-201…');
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
    await waitFor(() => expect(screen.getByTestId('lane-BBZ-118')).toHaveAttribute('data-state', 'running'));
  });

  it('shows the disconnected banner once the feed drops', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());
    global.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await waitFor(() => expect(screen.getByText(/live feed lost/)).toBeInTheDocument(), { timeout: 15_000 });
  }, 20_000);

  it('D2.1: a 501 refusal card survives the refresh runAction fires right after appending it', async () => {
    // `runAction` appends the refusal card via `appendReceipt`, then immediately calls
    // `refresh()`. `refresh()` replaces `state.thread` wholesale from `/thread`, which
    // has no row for a client-only refusal card -- so without a fix the card renders
    // for one tick and is gone once the refresh's own `/thread` fetch lands.
    await fetch('/__test/fixture?name=refusal-501', { method: 'POST' });
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    const tile = await screen.findByTestId('lane-FLT-401');
    await userEvent.click(within(tile).getByText('Compact + resume →', { exact: true }));
    await waitFor(() => expect(screen.getByText('Refused')).toBeInTheDocument());
    // Give the `refresh()` that `runAction` awaits right after appending the card time
    // to complete its own round trip and overwrite `state.thread`.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(screen.getByText('Refused')).toBeInTheDocument();
    expect(screen.getByText('compaction has no successor worker built yet')).toBeInTheDocument();
    expect(tile).toHaveAttribute('data-state', 'exhausted');
  });
});
