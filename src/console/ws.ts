/**
 * The `/events` client: reconnect with backoff, never a silent drop.
 *
 * `WebSocketImpl` and `url` are constructor options rather than globals so a
 * test can hand this a fake socket and drive `onopen` / `onclose` /
 * `onmessage` by hand instead of standing up a real server.
 */
import type { ConnectionStatus, ForgeEvent } from './types.js';

export interface EventStreamHandlers {
  onEvent: (event: ForgeEvent) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

export interface EventStreamOptions {
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: (attempt: number) => number;
}

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/events`;
}

function defaultBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export class EventStream {
  private socket: WebSocket | undefined;

  private attempt = 0;

  private stoppedByCaller = false;

  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly impl: typeof WebSocket;

  private readonly url: string;

  private readonly backoff: (attempt: number) => number;

  constructor(private readonly handlers: EventStreamHandlers, options: EventStreamOptions = {}) {
    this.impl = options.WebSocketImpl ?? WebSocket;
    this.url = options.url ?? defaultUrl();
    this.backoff = options.backoffMs ?? defaultBackoff;
  }

  start(): void {
    this.stoppedByCaller = false;
    this.connect();
  }

  stop(): void {
    this.stoppedByCaller = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  private connect(): void {
    this.handlers.onStatusChange('connecting');
    const socket = new this.impl(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatusChange('open');
    };

    socket.onmessage = (message) => {
      try {
        this.handlers.onEvent(JSON.parse(String(message.data)) as ForgeEvent);
      } catch {
        // A frame that will not parse teaches nothing; the stream carries on.
      }
    };

    socket.onclose = () => {
      this.handlers.onStatusChange('closed');
      if (this.stoppedByCaller) return;
      const delay = this.backoff(this.attempt);
      this.attempt += 1;
      this.timer = setTimeout(() => this.connect(), delay);
    };

    socket.onerror = () => socket.close();
  }
}
