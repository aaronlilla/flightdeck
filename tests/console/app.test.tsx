// @vitest-environment jsdom
import type { Server } from 'node:http';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/console/App.js';
import { createStubServer, resetStubDb } from '../../src/console/stub-server.js';

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
  it('renders the 13-lane board and opens the ticket sheet for a lane', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());
    expect(screen.getAllByText(/FLT-|BBZ-/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('lane-FLT-201'));
    await waitFor(() => expect(screen.getByTestId('ticket-sheet')).toBeInTheDocument());
  });

  it('walks board -> answer a parked lane -> receipt card in the rail', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByText('NOT NULL')).toBeInTheDocument());
    await userEvent.click(screen.getByText('NOT NULL'));
    await waitFor(() => expect(screen.getByTestId('rail-thread').textContent).toMatch(/resumed/));
  });

  it('requires a confirm card before a kill goes through', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toBeInTheDocument());
    await userEvent.click(within(screen.getByTestId('lane-FLT-204')).getByText('Kill attempt'));
    expect(screen.getByText('Confirm — irreversible')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByTestId('lane-FLT-204')).toHaveAttribute('data-state', 'killed'));
  });

  it('shows the disconnected banner once the feed drops', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());
    global.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await waitFor(() => expect(screen.getByText(/live feed lost/)).toBeInTheDocument(), { timeout: 15_000 });
  }, 20_000);
});
