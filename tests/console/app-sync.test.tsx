// @vitest-environment jsdom
/**
 * App-level wiring for the re-sync surfaces (R-71): one `GET /sync` per `sync` slice
 * frame, and a `SyncCard` with the right `scope` mounted on every host view.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/console/api.js', () => ({
  getLanes: vi.fn(async () => ({ at: Date.now(), lanes: [], tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } })),
  getThread: vi.fn(async () => ({ messages: [] })),
  getIntegrations: vi.fn(async () => ({ items: [] })),
  getCaps: vi.fn(async () => ({ dailyTokens: 0, tokensToday: 0, runTokens: 0 })),
  getProposals: vi.fn(async () => ({ rules: [], metrics: {}, computedAt: Date.now() })),
  getQueue: vi.fn(async () => ({ items: [], paused: false, maxInFlight: 4 })),
  getState: vi.fn(async () => ({ queue_on: true, build: 'test', project: null })),
  getBlockers: vi.fn(async () => ({ blockers: [], chains: [] })),
  getAccounts: vi.fn(async () => ({ items: [] })),
  getMachine: vi.fn(async () => ({ glance: '', readAt: Date.now(), intervalMs: 5000, sessions: [], unregistered: [] })),
  getSync: vi.fn(async () => ({
    runs: { full: null, queue: null, sessions: null, accounts: null, machine: null, inbox: null, lanes: null },
    watcher: { on: false, project: null, pollSeconds: 30 },
  })),
  ApiError: class ApiError extends Error {},
  isConfirmPending: (v: unknown) => typeof v === 'object' && v !== null && (v as { pending?: unknown }).pending === true,
  sendCommand: vi.fn(async () => ({ cards: [] })),
  getLeftovers: vi.fn(async () => ({ items: [] })),
  connectAccount: vi.fn(),
  getConnectAttempt: vi.fn(),
  disconnectAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteLeftover: vi.fn(),
}));
import * as api from '../../src/console/api.js';
import { App } from '../../src/console/App.js';

/** A controllable stand-in for the `/events` socket: `emit` fires `onmessage` with a
 *  JSON frame, exactly what a real slice event looks like on the wire. */
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static instances: FakeSocket[] = [];
  constructor(_url: string) {
    FakeSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  close(): void { this.onclose?.(); }
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

afterEach(() => { FakeSocket.instances = []; vi.clearAllMocks(); });

describe('App wires the sync slice', () => {
  it('fetches /sync once on load, and once more after a sync slice frame', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(api.getSync).toHaveBeenCalledTimes(1));

    const socket = FakeSocket.instances[0]!;
    await act(async () => { socket.emit({ type: 'slice', slice: 'sync', reason: 'test', at: Date.now() }); });

    await waitFor(() => expect(api.getSync).toHaveBeenCalledTimes(2));
  });

  it('mounts a SyncCard with the right scope on Board, Queue, Machine, Blockers and Settings→Accounts', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(api.getSync).toHaveBeenCalled());

    // Board is the default view.
    expect(screen.getByTestId('sync-card-lanes')).toBeTruthy();

    fireEvent.click(screen.getByTestId('nav-queue'));
    expect(screen.getByTestId('sync-card-queue')).toBeTruthy();

    fireEvent.click(screen.getByTestId('nav-machine'));
    expect(screen.getByTestId('sync-card-machine')).toBeTruthy();

    fireEvent.click(screen.getByTestId('nav-blockers'));
    expect(screen.getByTestId('sync-card-inbox')).toBeTruthy();

    fireEvent.click(screen.getByTestId('nav-settings'));
    expect(screen.getByTestId('sync-card-accounts')).toBeTruthy();
  });
});
