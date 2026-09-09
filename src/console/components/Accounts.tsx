import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { hm } from '../freshness.js';
import { durationWords } from '../laneVM.js';
import type { AccountItem, ConnectState } from '../../shared/console-model.js';
import { connectAccount, disconnectAccount, getConnectAttempt } from '../api.js';
import { Marks } from './QuestionCard.js';

export interface AccountsProps {
  accounts: AccountItem[];
  now: number;
  /** Called once a connect finishes (`connected`) or a disconnect succeeds, so the
   *  caller can refetch the accounts slice. This component never refetches its own
   *  `accounts` prop -- the same read-from-props-write-through-callback shape every
   *  other panel here already uses. */
  onChanged?: () => void;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 1000;

const STATE_LABEL: Record<ConnectState, string> = {
  connecting: 'Connecting',
  'waiting-in-browser': 'Waiting on the browser',
  probing: 'Confirming the login',
  connected: 'Connected',
  failed: 'Failed',
};

const WINDOW_LABEL: Record<'five_hour' | 'seven_day', string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
};

/**
 * The AI accounts section of Settings (`Flightdeck Console.dc.html` 1e): one row per
 * connected account with its plan and its limit state, plus the control that adds
 * another.
 *
 * The design draws a headroom bar with a percentage. Nothing reports one: the Claude
 * SDK gives per-turn token usage and context-window remaining, but no account-level
 * five-hour or seven-day figure, so the only account-level signal is the reset time
 * carried by a rate-limit error. This row shows the state that can be proved -- ready,
 * or limited until a named time -- and the bar stays out until something real can fill
 * it. Never a percentage with no measurement behind it.
 */
export function Accounts({ accounts, now, onChanged, pollMs = DEFAULT_POLL_MS }: AccountsProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [connectState, setConnectState] = useState<ConnectState | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [disconnectErrors, setDisconnectErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
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
        setAdding(false);
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
      setStartError(started.error ?? 'the connect did not start');
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
      setDisconnectErrors((prev) => ({ ...prev, [id]: result.error ?? 'the disconnect failed' }));
      return;
    }
    onChanged?.();
  }

  return (
    <section data-testid="accounts" style={{ display: 'flex', flexDirection: 'column', gap: 10, gridColumn: '1/-1' }}>
      <h6 className="sec">AI accounts <span className="n">{accounts.length}</span></h6>

      {accounts.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink2)' }}>None. Runs use the fleet login.</p>
      ) : null}

      {accounts.map((account) => {
        const limited = account.limitedUntil !== undefined && account.limitedUntil > now;
        return (
          <div
            key={account.id} data-testid={`account-${account.id}`}
            style={{
              position: 'relative', border: `1px solid ${limited ? 'var(--warn)' : 'var(--line)'}`, padding: '14px 18px',
              display: 'grid', gridTemplateColumns: '150px minmax(0,1fr) 200px auto', gap: 18, alignItems: 'center',
              background: limited ? 'var(--warnTint)' : 'transparent',
            }}
          >
            <Marks />
            <div>
              <div className="hd" style={{ fontSize: 'var(--fs-heading)' }}>{account.label}</div>
              <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
                {account.plan ? `${account.plan} plan` : 'plan not read yet'}{account.selected ? ' · in use' : ''}
              </div>
            </div>
            <div data-testid={`account-state-${account.id}`} style={{ color: limited ? 'var(--warn)' : 'var(--ink)' }}>
              {limited
                ? `Limited on the ${WINDOW_LABEL[account.limitedWindow ?? 'five_hour']} until ${hm(account.limitedUntil!)}`
                : 'Ready'}
              <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
                {limited ? `frees in ${durationWords(account.limitedUntil! - now)}` : 'no limit hit yet'}
              </div>
            </div>
            <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
              {account.liveRuns} live run{account.liveRuns === 1 ? '' : 's'}
            </span>
            <button type="button" className="btn" style={{ padding: '6px 14px' }} onClick={() => { void handleDisconnect(account.id); }}>
              Disconnect
            </button>
            {disconnectErrors[account.id] ? (
              <span role="alert" style={{ gridColumn: '1/-1', fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{disconnectErrors[account.id]}</span>
            ) : null}
          </div>
        );
      })}

      {adding ? (
        <form
          style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}
          onSubmit={(event) => { event.preventDefault(); void handleConnect(); }}
        >
          <label htmlFor="accounts-connect-label" className="kick" style={{ alignSelf: 'center' }}>Label</label>
          <input
            id="accounts-connect-label" className="inp" value={label} disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
          <button type="submit" className="btn primary" style={{ padding: '6px 14px' }} disabled={pending || !label.trim()}>
            Connect
          </button>
          <button type="button" className="btn" style={{ padding: '6px 14px' }} onClick={() => { setAdding(false); setConnectState(null); }}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button" className="btn" data-testid="add-account"
          style={{ alignSelf: 'flex-start', padding: '6px 14px' }}
          onClick={() => setAdding(true)}
        >
          Add an account
        </button>
      )}

      {connectState ? (
        <span data-testid="connect-state" role="status" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>
          {STATE_LABEL[connectState]}
        </span>
      ) : null}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" data-testid="connect-link" style={{ fontSize: 'var(--fs-meta)' }}>
          Open the login link
        </a>
      ) : null}
      {attemptError ? <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{attemptError}</span> : null}
      {startError ? <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{startError}</span> : null}
    </section>
  );
}
