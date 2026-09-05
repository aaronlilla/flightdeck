// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/console/App.js';
import { fleetStateFixture } from '../../src/console/fixtures/state.js';
import { emptyInboxFixture } from '../../src/console/fixtures/inbox.js';

class FakeSocket {
  onopen: (() => void) | null = null;

  onclose: (() => void) | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;

  onerror: (() => void) | null = null;

  close(): void {
    this.onclose?.();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.head.innerHTML = '<meta name="forge-token" content="tok" />';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TicketSheet (X3)', () => {
  // X3: a tile opens a ticket sheet carrying the packet, the provenance chain,
  // and the not-yet-wired fields named explicitly rather than left blank.
  it('opens from a lane tile and shows the packet, provenance, and not-wired fields', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path === '/state') return Promise.resolve(jsonResponse(fleetStateFixture));
      if (path === '/inbox') return Promise.resolve(jsonResponse(emptyInboxFixture));
      if (path === '/run/card-network-glow') {
        return Promise.resolve(jsonResponse({
          run: 'card-network-glow',
          packet: '# what this run found',
          plan: null,
          prUrl: null,
          council: null,
          comments: null,
          provenance: { predecessor: null, successor: 'card-network-glow-2' },
          state: null,
        }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const user = userEvent.setup();
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);

    const tile = (await screen.findByText('card-network-glow')).closest('.lane-tile')!;
    await user.click(tile);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByText('# what this run found')).toBeTruthy();
    expect(screen.getAllByText('not wired').length).toBeGreaterThan(0);
    expect(screen.getByText(/handed off to card-network-glow-2/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
