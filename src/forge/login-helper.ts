/**
 * The logon-time login helper (R-53): a service in Session 0 cannot open a browser, so
 * connecting a new account has to happen from a small process on the user's own desktop
 * instead. This connects to the console's live event stream with the server token and,
 * on every `accounts.connect-requested {accountId, configDir}` event, runs the login
 * under that config dir, opens the captured URL, and posts progress back so the
 * console's state machine advances exactly as it does in-process today.
 *
 * Event-driven throughout, never a poll: one WebSocket connection, reconnected with
 * backoff only on a drop. `hooks/liveness_guard.py` denies sleeps and polls a session
 * types by hand; this is the same rule applied to what ships.
 */
export interface ConnectRequestedEvent {
  event: 'accounts.connect-requested';
  accountId: string;
  configDir: string;
  provider?: 'claude' | 'codex';
}

export interface LoginHelperSocket {
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
  close(): void;
}

export interface LoginHelperDeps {
  /** Opens one WebSocket connection to the console's `/events` stream. Production wires
   *  the real `WebSocket` (global as of Node 22+) with the server token in a header;
   *  every specimen hands in a fake that never touches the network. */
  connect: () => LoginHelperSocket | Promise<LoginHelperSocket>;
  /** Runs the login under the given config dir -- the same `LoginResult` shape
   *  `realSpawnLogin` returns in `accounts-connect.ts`. Injected so a specimen never
   *  spawns `claude auth login` for real. */
  spawnLogin: (provider: 'claude' | 'codex', configDir: string) => Promise<{ ok: boolean; link?: string; error?: string }>;
  /** Opens a URL on the user's desktop (`start ""` on Windows). Injected. */
  openUrl: (url: string) => void;
  /** Reports the outcome back to the console so its state machine advances. Injected. */
  postProgress: (accountId: string, outcome: { ok: boolean; link?: string; error?: string }) => Promise<void>;
  /** Backoff before a reconnect attempt, ms. Defaults to 2000. */
  reconnectDelayMs?: number;
  /** Test seam: overrides the real `setTimeout`. */
  wait?: (ms: number) => Promise<void>;
  onLog?: (line: string) => void;
}

function isConnectRequested(parsed: unknown): parsed is ConnectRequestedEvent {
  return Boolean(
    parsed && typeof parsed === 'object'
    && (parsed as Record<string, unknown>)['event'] === 'accounts.connect-requested'
    && typeof (parsed as Record<string, unknown>)['accountId'] === 'string'
    && typeof (parsed as Record<string, unknown>)['configDir'] === 'string',
  );
}

/** Runs the helper's whole lifecycle: connect, handle events, reconnect on drop, forever
 *  (until `stop()` is called). Returns a stop function rather than blocking, so a caller
 *  (the scheduled task's own entry point, or a test) controls its own lifetime. */
export function runLoginHelper(deps: LoginHelperDeps): { stop: () => void } {
  let stopped = false;
  const log = deps.onLog ?? (() => {});
  const wait = deps.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function handleEvent(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // Not every frame on this stream is a connect-request; ignore the rest.
    }
    if (!isConnectRequested(parsed)) return;
    const provider = parsed.provider ?? 'claude';
    log(`connect requested for ${parsed.accountId}`);
    try {
      const login = await deps.spawnLogin(provider, parsed.configDir);
      if (login.link) deps.openUrl(login.link);
      await deps.postProgress(parsed.accountId, login);
    } catch (error) {
      await deps.postProgress(parsed.accountId, {
        ok: false, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const socket = await deps.connect();
      const closed = new Promise<void>((resolve) => {
        socket.onClose(() => resolve());
        socket.onError(() => resolve());
      });
      socket.onMessage((data) => { void handleEvent(data); });
      log('connected');
      await closed;
      if (stopped) return;
      log('stream dropped, reconnecting');
      await wait(deps.reconnectDelayMs ?? 2000);
    }
  }

  void loop();

  return { stop: () => { stopped = true; } };
}
