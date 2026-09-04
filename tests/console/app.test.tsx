// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/console/App.js';
import { fleetStateFixture } from '../../src/console/fixtures/state.js';
import { emptyInboxFixture, inboxFixture } from '../../src/console/fixtures/inbox.js';

class FakeSocket {
  static instances: FakeSocket[] = [];

  onopen: (() => void) | null = null;

  onclose: (() => void) | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;

  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.onclose?.();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeSocket.instances = [];
  document.head.innerHTML = '<meta name="forge-token" content="tok" />';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('App', () => {
  // W1: the scaffold renders the command bar and the lanes grid from fixtures.
  it('renders lanes with model, context, cost per hour and state from /state', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path === '/state') return Promise.resolve(jsonResponse(fleetStateFixture));
      if (path === '/inbox') return Promise.resolve(jsonResponse(emptyInboxFixture));
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);

    expect(await screen.findByText('card-network-glow')).toBeTruthy();
    const tile = screen.getByText('card-network-glow').closest('.lane-tile')!;
    expect(tile.textContent).toContain('implement');
    expect(tile.textContent).toContain('claude-sonnet-5');
    expect(tile.textContent).toContain('$6.17/h');
    expect(screen.getByText('in-progress')).toBeTruthy();
  });

  // W3: an inbox entry renders as a card whose answer button posts to
  // /answer and clears once the server acknowledges it.
  it('answers an inbox card and clears it once the server responds', async () => {
    let inboxState = inboxFixture;
    fetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/state') return Promise.resolve(jsonResponse(fleetStateFixture));
      if (path === '/inbox') return Promise.resolve(jsonResponse(inboxState));
      if (path === '/answer' && init?.method === 'POST') {
        inboxState = { open: [], all: inboxState.all };
        return Promise.resolve(jsonResponse({ key: 'a1b2c3d4e5f60718', answer: 'dev' }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const user = userEvent.setup();
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);

    const question = await screen.findByText(/dev tenant or the production Auth0 tenant/);
    const card = question.closest('.inbox-card')!;
    const devButton = card.querySelector('button')!;
    await user.click(devButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/answer',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ key: 'a1b2c3d4e5f60718', answer: 'dev' }) }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText(/dev tenant or the production Auth0 tenant/)).toBeNull();
    });
  });

  // W4: the console never crashes when the server is unreachable, and shows
  // a disconnected state instead.
  it('shows a disconnected banner and disables Stop all when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);

    expect((await screen.findByRole('status')).textContent).toContain('Lost the connection');
    const stopButton = screen.getByRole('button', { name: /stop all/i });
    expect((stopButton as HTMLButtonElement).disabled).toBe(true);
  });

  // W5: Stop all calls /stop through api.ts.
  it('Stop all posts to /stop', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path === '/state') return Promise.resolve(jsonResponse(fleetStateFixture));
      if (path === '/inbox') return Promise.resolve(jsonResponse(emptyInboxFixture));
      return Promise.resolve(jsonResponse({ stopped: ['card-network-glow'] }));
    });

    const user = userEvent.setup();
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);

    const stopButton = await screen.findByRole('button', { name: /stop all/i });
    await act(async () => {
      await user.click(stopButton);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/stop',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
