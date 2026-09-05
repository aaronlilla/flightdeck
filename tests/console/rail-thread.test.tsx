// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

describe('rail thread (X4)', () => {
  it('shows router off and disables the message box while the policy has it off', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path === '/state') return Promise.resolve(jsonResponse({ ...fleetStateFixture, router_enabled: false }));
      if (path === '/inbox') return Promise.resolve(jsonResponse(emptyInboxFixture));
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);

    expect(await screen.findByText('router off')).toBeTruthy();
    const input = screen.getByLabelText('send a message to the fleet') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('posts to /router and shows the routed class once the policy has it on', async () => {
    fetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/state') return Promise.resolve(jsonResponse({ ...fleetStateFixture, router_enabled: true }));
      if (path === '/inbox') return Promise.resolve(jsonResponse(emptyInboxFixture));
      if (path === '/router' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ routed: true, outcome: { class: 'intake' } }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const user = userEvent.setup();
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);

    expect(await screen.findByText('router on')).toBeTruthy();
    const input = screen.getByLabelText('send a message to the fleet');
    await user.type(input, 'build the new thing');
    const railThread = input.closest('.rail-thread')!;
    await user.click(within(railThread as HTMLElement).getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/router',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'build the new thing' }) }),
      );
    });
    expect(await screen.findByText('routed as intake')).toBeTruthy();
  });
});
