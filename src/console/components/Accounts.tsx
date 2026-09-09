import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { AccountItem, ConnectState } from '../../shared/console-model.js';
import { connectAccount, disconnectAccount, getConnectAttempt } from '../api.js';

export interface AccountsProps {
  accounts: AccountItem[];
  /** Called once a connect finishes (`connected`) or a disconnect succeeds, so the
   *  caller can refetch the accounts slice. This component never refetches its own
   *  `accounts` prop -- the same read-from-props-write-through-callback shape every
   *  other panel here already uses. */
  onChanged?: () => void;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 1000;

const STATE_LABEL: Record<ConnectState, string> = {
  connecting: 'Connecting…',
  'waiting-in-browser': 'Waiting on the browser…',
  probing: 'Confirming the login…',
  connected: 'Connected',
  failed: 'Failed',
};

/**
 * The Accounts panel: a connect form (label + Connect, polling the attempt it starts)
 * and a list of connected accounts, each with its own Disconnect button.
 *
 * Every write goes through `api.ts` (`connectAccount`, `getConnectAttempt`,
 * `disconnectAccount`), never a raw `fetch`, matching every other console panel.
 */
export function Accounts({ accounts, onChanged, pollMs = DEFAULT_POLL_MS }: AccountsProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [connectState, setConnectState] = useState<ConnectState | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [disconnectErrors, setDisconnectErrors] = useState<Record<string, string>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const pending = connectState !== null && connectState !== 'connected' && connectState !== 'failed';

  function stopPolling(): void {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function pollOnce(attemptId: string): Promise<void> {
    const attempt = await getConnectAttempt(attemptId);
    setConnectState(attempt.state);
    if (attempt.link) setLink(attempt.link);
    if (attempt.error) setAttemptError(attempt.error);
    if (attempt.state === 'connected' || attempt.state === 'failed') {
      stopPolling();
      if (attempt.state === 'connected') {
        setLabel('');
        onChanged?.();
      }
    }
  }

  async function handleConnect(): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed || pending) return;
    setStartError(null);
    setAttemptError(null);
    setLink(null);
    const started = await connectAccount(trimmed);
    if (!started.ok || !started.attemptId) {
      setStartError(started.error ?? 'could not start the connect attempt');
      return;
    }
    setConnectState('connecting');
    const attemptId = started.attemptId;
    timerRef.current = setInterval(() => { void pollOnce(attemptId); }, pollMs);
  }

  async function handleDisconnect(id: string): Promise<void> {
    setDisconnectErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const result = await disconnectAccount(id);
    if (!result.ok) {
      setDisconnectErrors((prev) => ({ ...prev, [id]: result.error ?? 'could not disconnect this account' }));
      return;
    }
    onChanged?.();
  }

  return (
    <section className="accounts-panel" aria-label="Accounts">
      <h2>Accounts</h2>

      <form
        className="accounts-connect-form"
        onSubmit={(event) => { event.preventDefault(); void handleConnect(); }}
      >
        <label htmlFor="accounts-connect-label">Label</label>
        <input
          id="accounts-connect-label"
          value={label}
          disabled={pending}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button type="submit" disabled={pending || !label.trim()}>
          Connect
        </button>
      </form>

      {connectState && (
        <div data-testid="connect-state" role="status">
          {STATE_LABEL[connectState]}
        </div>
      )}
      {link && (
        <a href={link} target="_blank" rel="noreferrer" data-testid="connect-link">
          Open the login link
        </a>
      )}
      {attemptError && <div role="alert">{attemptError}</div>}
      {startError && <div role="alert">{startError}</div>}

      <ul className="accounts-list">
        {accounts.map((account) => (
          <li key={account.id} data-testid={`account-${account.id}`}>
            <span>{account.label}</span>
            <span>{account.liveRuns} live run{account.liveRuns === 1 ? '' : 's'}</span>
            <button type="button" onClick={() => { void handleDisconnect(account.id); }}>
              Disconnect
            </button>
            {disconnectErrors[account.id] && <div role="alert">{disconnectErrors[account.id]}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
