// @vitest-environment jsdom
/**
 * W4: the `/events` client reconnects with backoff and never leaves a
 * caller guessing at its status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventStream } from '../../src/console/ws.js';

class FakeSocket {
  static instances: FakeSocket[] = [];

  onopen: (() => void) | null = null;

  onclose: (() => void) | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;

  onerror: (() => void) | null = null;

  closed = false;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EventStream', () => {
  it('reports connecting then open, and delivers a parsed event', () => {
    const statuses: string[] = [];
    const events: unknown[] = [];
    const stream = new EventStream(
      { onEvent: (event) => events.push(event), onStatusChange: (status) => statuses.push(status) },
      { url: 'ws://example.invalid/events', WebSocketImpl: FakeSocket as unknown as typeof WebSocket },
    );
    stream.start();
    expect(statuses).toEqual(['connecting']);

    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    expect(statuses).toEqual(['connecting', 'open']);

    socket.onmessage?.({ data: JSON.stringify({ event: 'run.resumed', run: 'a' }) });
    expect(events).toEqual([{ event: 'run.resumed', run: 'a' }]);
  });

  it('reconnects with backoff after a close, and stops trying once told to stop', () => {
    const statuses: string[] = [];
    const stream = new EventStream(
      { onEvent: () => {}, onStatusChange: (status) => statuses.push(status) },
      {
        url: 'ws://example.invalid/events',
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
        backoffMs: () => 1000,
      },
    );
    stream.start();
    FakeSocket.instances[0]!.close();
    expect(statuses).toEqual(['connecting', 'closed']);
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(statuses).toEqual(['connecting', 'closed', 'connecting']);

    stream.stop();
    FakeSocket.instances[1]!.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
