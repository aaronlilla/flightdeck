// @vitest-environment jsdom
/**
 * Load-verify finding (docs/load-verify.md): `App.tsx`'s 5s poll and every `/events`
 * frame both call the same `refresh()`, and neither one waited for the other. A `/lanes`
 * response slower than the 5s poll interval -- exactly what a large fleet produces --
 * let two, three, or more `Promise.all` fetch batches pile up concurrently, each one
 * itself containing a `/lanes` call, which made the pile-up worse under the load that
 * caused it in the first place.
 */
import type { Server } from 'node:http';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

describe('App refresh concurrency', () => {
  it('never starts a second refresh while one is still in flight', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getByTestId('lane-FLT-201')).toBeInTheDocument());

    // The board's own `/lanes` fetch, held open past the moment a second trigger fires --
    // standing in for the slow response a few thousand lanes over a few hundred thousand
    // journal events produces in practice.
    let lanesCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/lanes')) {
        lanesCalls += 1;
        await gate;
      }
      return gatedFetch(input, init);
    }) as typeof fetch;

    const socket = FakeSocket.instances[0]!;
    // Three server frames land back to back -- exactly what a live fleet does -- while
    // the first refresh this triggers is still waiting on the gated `/lanes` fetch above.
    // A heartbeat no longer triggers a full refresh (it re-reads `/state` alone, the
    // build check); an event App.tsx does not recognize as a slice event still falls
    // through to `refresh()` (App.tsx's `onEvent`), so that is what exercises the guard.
    socket.onmessage?.({ data: JSON.stringify({ type: 'tool.start', run: 'FLT-201' }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'tool.start', run: 'FLT-201' }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'tool.start', run: 'FLT-201' }) });

    expect(lanesCalls).toBe(1);

    release();
    await waitFor(() => expect(lanesCalls).toBe(1));
  });
});
