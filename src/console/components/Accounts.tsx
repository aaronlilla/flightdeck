import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { hm } from '../freshness.js';
import { durationWords } from '../laneVM.js';
import type { AccountItem, AccountProvider, AccountWindow, ConnectState } from '../../shared/console-model.js';
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

const PROVIDER_LABEL: Record<AccountProvider, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
};

/** `hm(at)` when `at` falls within a day of `now`; otherwise the short weekday plus
 *  `hm(at)`, so a reset days out still reads at a glance. `null` reads "unknown". */
function resetWords(at: number | null, now: number): string {
  if (at === null) return 'unknown';
  if (Math.abs(at - now) < 24 * 60 * 60 * 1000) return hm(at);
  const day = new Date(at).toLocaleDateString('en-US', { weekday: 'short' });
  return `${day} ${hm(at)}`;
}

/** A window reads warn once it is most of the way used, or once the provider itself
 *  flags it as something other than normal -- an absent severity is not a flag. */
function windowWarn(w: AccountWindow): boolean {
  return w.usedPct >= 80 || (w.severity !== undefined && w.severity !== 'normal');
}

function WindowsBlock({ account, now }: { account: AccountItem; now: number }): JSX.Element {
  if (account.windows.length === 0) {
    return account.readError ? (
      <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{`limits unavailable · ${account.readError}`}</span>
    ) : (
      <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>reading limits…</span>
    );
  }
  return (
    <>
      {account.windows.map((w) => (
        <div key={w.key} style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-meta)' }}>
            <span>{w.label}</span>
            <span style={{ color: 'var(--ink3)' }}>{`${w.usedPct}% used · resets ${resetWords(w.resetsAt, now)}`}</span>
          </div>
          <div style={{ height: 6, border: '1px solid var(--line2)', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${w.usedPct}%`, background: windowWarn(w) ? 'var(--warn)' : 'var(--acc)' }} />
          </div>
        </div>
      ))}
      {account.readAt !== undefined ? (
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{`read ${durationWords(now - account.readAt)} ago`}</div>
      ) : null}
    </>
  );
}

/**
 * The AI accounts section of Settings (`Flightdeck Console.dc.html` 1e): one row per
 * linked account -- named by the email the subscription is under, never a label --
 * with its plan, its live usage windows and when each one resets, plus the controls
 * to link a Claude or a ChatGPT account and to unlink one already linked.
 *
 * The windows and their percentages are read live from the provider's own usage
 * endpoint through the server (`accounts-probe.ts`); this component only renders what
 * it is handed and never estimates a figure the provider did not report.
 */
export function Accounts({ accounts, now, onChanged, pollMs = DEFAULT_POLL_MS }: AccountsProps): JSX.Element {
  const [connectProvider, setConnectProvider] = useState<AccountProvider | null>(null);
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
        setConnectState(null);
        setConnectProvider(null);
        setLink(null);
        onChanged?.();
      }
    }
  }

  async function handleConnect(provider: AccountProvider): Promise<void> {
    if (pending) return;
    setStartError(null);
    setAttemptError(null);
    setLink(null);
    setConnectProvider(provider);
    const started = await connectAccount(provider);
    if (!started.ok || !started.attemptId) {
      setStartError(started.error ?? 'the connect did not start');
      setConnectProvider(null);
      return;
    }
    setConnectState('connecting');
    const attemptId = started.attemptId;
    timerRef.current = setInterval(() => { void pollOnce(attemptId); }, pollMs);
  }

  function cancelConnect(): void {
    stopPolling();
    setConnectState(null);
    setConnectProvider(null);
    setLink(null);
    setAttemptError(null);
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h6 className="sec">AI accounts <span className="n">{accounts.length}</span></h6>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" data-testid="link-claude" disabled={pending} onClick={() => { void handleConnect('claude'); }}>
            Link Claude
          </button>
          <button type="button" className="btn" data-testid="link-codex" disabled={pending} onClick={() => { void handleConnect('codex'); }}>
            Link ChatGPT
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink2)' }}>None · default login</p>
      ) : null}

      {accounts.map((account) => {
        const limited = account.limitedUntil !== undefined && account.limitedUntil > now;
        const meta = [
          account.plan ? `${account.plan} plan` : null,
          account.selected ? 'in use' : null,
          account.fleet ? 'default login' : null,
        ].filter(Boolean).join(' · ');
        return (
          <div
            key={account.id} data-testid={`account-${account.id}`}
            style={{
              position: 'relative', border: `1px solid ${limited ? 'var(--warn)' : 'var(--line)'}`, padding: '14px 18px',
              display: 'grid', gridTemplateColumns: '170px minmax(0,1fr) 110px auto', gap: 18, alignItems: 'center',
              background: limited ? 'var(--warnTint)' : 'transparent',
            }}
          >
            <Marks />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <i className="led" style={{ background: 'var(--ink3)' }} />
                <span className="kick">{PROVIDER_LABEL[account.provider]}</span>
              </div>
              <div className="hd" style={{ fontSize: 'var(--fs-heading)', overflowWrap: 'anywhere' }}>{account.email ?? 'reading…'}</div>
              {meta ? <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{meta}</div> : null}
            </div>
            <div data-testid={`account-windows-${account.id}`} style={{ minWidth: 0 }}>
              <WindowsBlock account={account} now={now} />
              {limited ? (
                <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>
                  {`Limited on the ${WINDOW_LABEL[account.limitedWindow ?? 'five_hour']} until ${hm(account.limitedUntil!)}`}
                </div>
              ) : null}
            </div>
            <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{`${account.liveRuns} live run${account.liveRuns === 1 ? '' : 's'}`}</span>
            {account.fleet ? null : (
              <button type="button" className="btn" style={{ padding: '6px 14px' }} onClick={() => { void handleDisconnect(account.id); }}>
                Unlink
              </button>
            )}
            {disconnectErrors[account.id] ? (
              <span role="alert" style={{ gridColumn: '1/-1', fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{disconnectErrors[account.id]}</span>
            ) : null}
          </div>
        );
      })}

      {connectState !== null ? (
        <div data-testid="connect-pending" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="kick">{connectProvider ? PROVIDER_LABEL[connectProvider] : ''}</span>
          <span data-testid="connect-state" role="status" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>
            {STATE_LABEL[connectState]}
          </span>
          {link ? (
            <a href={link} target="_blank" rel="noreferrer" data-testid="connect-link" style={{ fontSize: 'var(--fs-meta)' }}>
              Open the login page
            </a>
          ) : null}
          {attemptError ? <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{attemptError}</span> : null}
          <button type="button" className="btn" style={{ padding: '6px 14px' }} onClick={cancelConnect}>
            Cancel
          </button>
        </div>
      ) : null}
      {startError ? <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{startError}</span> : null}
    </section>
  );
}
