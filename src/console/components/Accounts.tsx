import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { hm } from '../freshness.js';
import { durationWords } from '../laneVM.js';
import type {
  AccountItem, AccountProvider, AccountUpdateRequest, AccountWindow, ConnectState, LeftoverItem,
} from '../../shared/console-model.js';
import {
  connectAccount, deleteLeftover, disconnectAccount, getConnectAttempt, getLeftovers, isConfirmPending,
  setDefaultLoginOff, updateAccount,
} from '../api.js';
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

/** `740 MB`, `1.2 GB`, `84 KB`. The number is there so a delete is a decision about a
 *  known amount rather than about the word "files". */
function sizeWords(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

/**
 * Which providers have linked accounts and no usable one left, with the earliest reset
 * across them.
 *
 * Read from the same wire fields the server refuses a launch on, so the banner and the
 * refusal cannot disagree. The fleet row is excluded: it is the fallback, not a linked
 * account, and counting it would hide the very state this warns about.
 */
function spentProviders(
  accounts: AccountItem[], now: number,
): { provider: AccountProvider; earliestReset: number | null }[] {
  const out: { provider: AccountProvider; earliestReset: number | null }[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const rows = accounts.filter((account) => account.provider === provider && !account.fleet);
    if (rows.length === 0) continue;
    const spent = rows.every((account) => (
      (account.limitedUntil !== undefined && account.limitedUntil > now)
      || (account.maxConcurrent !== undefined && account.liveRuns >= account.maxConcurrent)
    ));
    if (!spent) continue;
    let earliest: number | null = null;
    for (const account of rows) {
      for (const at of [account.limitedUntil, ...account.windows.map((w) => w.resetsAt)]) {
        if (at === undefined || at === null || at <= now) continue;
        if (earliest === null || at < earliest) earliest = at;
      }
    }
    out.push({ provider, earliestReset: earliest });
  }
  return out;
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
  const [patchErrors, setPatchErrors] = useState<Record<string, string>>({});
  const [leftoverError, setLeftoverError] = useState<string | null>(null);
  const [confirmingLeftover, setConfirmingLeftover] = useState<{ name: string; token: string } | null>(null);
  const [leftovers, setLeftovers] = useState<LeftoverItem[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  // Re-read the leftovers whenever the account list changes, since an unlink is exactly
  // what creates one. A failure here leaves the last list standing and says nothing: a
  // leftover the console cannot see is a tidy-up that did not happen, never an error
  // worth putting in front of someone.
  useEffect(() => {
    let live = true;
    void getLeftovers()
      .then((response) => { if (live) setLeftovers(response.items); })
      .catch(() => { /* the section simply does not appear */ });
    return () => { live = false; };
  }, [accounts]);

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

  /** One writer for both spending controls, because they are one decision. Writes
   *  through and refetches rather than updating locally: the registry is what decides,
   *  and a row that shows a value the registry refused is worse than a slow one. */
  async function patch(id: string, body: AccountUpdateRequest): Promise<void> {
    setPatchErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const result = await updateAccount(id, body);
    if (!result.ok) {
      setPatchErrors((prev) => ({ ...prev, [id]: result.error ?? 'that change was refused' }));
      return;
    }
    onChanged?.();
  }

  /** The machine's own login has no registry row to patch, so its one control writes
   *  through here instead. Same shape as `patch`: write, refetch, show the refusal on the
   *  row rather than guessing the new state locally. */
  async function setOff(off: boolean): Promise<void> {
    setPatchErrors((prev) => {
      const next = { ...prev };
      delete next['fleet'];
      return next;
    });
    const result = await setDefaultLoginOff(off);
    if (!result.ok) {
      setPatchErrors((prev) => ({ ...prev, fleet: result.error ?? 'that change was refused' }));
      return;
    }
    onChanged?.();
  }

  /** Two passes, the same gate every other destructive control here uses. The first
   *  call deletes nothing and comes back with a server-issued token; only a second call
   *  carrying that token removes anything, so a stray click cannot. */
  async function handleDeleteLeftover(name: string, confirm?: string): Promise<void> {
    setLeftoverError(null);
    const result = await deleteLeftover(name, confirm);
    if (isConfirmPending(result)) {
      setConfirmingLeftover({ name, token: result.token });
      return;
    }
    if (!result.ok) {
      setLeftoverError(result.error ?? 'those files could not be removed');
      setConfirmingLeftover(null);
      return;
    }
    setConfirmingLeftover(null);
    setLeftovers((prev) => prev.filter((row) => row.name !== name));
    onChanged?.();
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

      {/* Every linked account of a provider spent at once. A launch refuses at this
          point rather than borrowing the machine login, so the row that says when it
          frees up is the difference between "stopped" and "broken". */}
      {spentProviders(accounts, now).map(({ provider, earliestReset }) => (
        <div
          key={provider} role="alert" data-testid={`accounts-spent-${provider}`}
          style={{ border: '1px solid var(--warn)', background: 'var(--warnTint)', padding: '10px 14px', fontSize: 'var(--fs-meta)' }}
        >
          <strong>{`${PROVIDER_LABEL[provider]}: every account spent`}</strong>
          <span style={{ color: 'var(--ink3)', marginLeft: 8 }}>
            {earliestReset === null ? 'no new runs' : `no new runs · frees in ${durationWords(earliestReset - now)}`}
          </span>
        </div>
      ))}

      {accounts.map((account) => {
        const limited = account.limitedUntil !== undefined && account.limitedUntil > now;
        // Whether there is a Claude login besides this machine's own. Without one, the
        // machine has nothing else to run on and the switch is not offered.
        const otherClaudeLinked = accounts.some((row) => row.provider === 'claude' && !row.fleet);
        const meta = [
          account.plan ? `${account.plan} plan` : null,
          account.selected ? 'in use' : null,
          account.fleet ? (account.off ? 'this machine’s login · switched off' : 'this machine’s login') : null,
        ].filter(Boolean).join(' · ');
        return (
          <div
            key={account.id} data-testid={`account-${account.id}`}
            style={{
              position: 'relative', border: `1px solid ${limited ? 'var(--warn)' : 'var(--line)'}`, padding: '14px 18px',
              display: 'grid', gridTemplateColumns: '240px minmax(0,1fr) 110px auto', gap: 18, alignItems: 'center',
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
            {account.fleet ? (
              /* No registry row, so nothing to unlink -- what this login can be is taken
                 out of the rotation, which is what Aaron was reaching for when he said he
                 had no way to stop the spent one being used. Only offered while another
                 Claude account is linked, because this is the only login a machine with
                 none has, and the server refuses that case too. */
              otherClaudeLinked ? (
                <div className="seg" role="group" aria-label="Whether this machine's own login may be used">
                  <button
                    type="button" aria-pressed={account.off !== true}
                    data-testid="default-login-on"
                    onClick={() => { void setOff(false); }}
                  >
                    Use
                  </button>
                  <button
                    type="button" aria-pressed={account.off === true}
                    data-testid="default-login-off"
                    onClick={() => { void setOff(true); }}
                  >
                    Off
                  </button>
                </div>
              ) : null
            ) : (
              <button type="button" className="btn" style={{ padding: '6px 14px' }} onClick={() => { void handleDisconnect(account.id); }}>
                Unlink
              </button>
            )}
            {/* The two spending controls, on their own line so they wrap rather than
                squeezing the email and the windows at a narrow width. Never on the fleet
                row: it has no registry entry to patch. */}
            {account.fleet ? null : (
              <div
                data-testid={`account-controls-${account.id}`}
                style={{
                  gridColumn: '1/-1', display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap',
                  borderTop: '1px solid var(--line2)', paddingTop: 10,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="kick">Use</span>
                  <div className="seg" role="group" aria-label={`How ${account.email ?? account.id} may be used`}>
                    <button
                      type="button" aria-pressed={!account.lastResort}
                      data-testid={`use-freely-${account.id}`}
                      onClick={() => { void patch(account.id, { lastResort: false }); }}
                    >
                      Freely
                    </button>
                    <button
                      type="button" aria-pressed={account.lastResort === true}
                      data-testid={`hold-back-${account.id}`}
                      onClick={() => { void patch(account.id, { lastResort: true }); }}
                    >
                      Hold back
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="kick">At once</span>
                  <div className="step">
                    <button
                      type="button" aria-label="Fewer at once"
                      data-testid={`ceiling-down-${account.id}`}
                      onClick={() => { void patch(account.id, { maxConcurrent: Math.max(0, (account.maxConcurrent ?? 0) - 1) }); }}
                    >
                      −
                    </button>
                    <span data-testid={`ceiling-${account.id}`} style={{ minWidth: 64, textAlign: 'center' }}>
                      {account.maxConcurrent === undefined ? 'no limit' : account.maxConcurrent}
                    </span>
                    <button
                      type="button" aria-label="More at once"
                      data-testid={`ceiling-up-${account.id}`}
                      onClick={() => { void patch(account.id, { maxConcurrent: (account.maxConcurrent ?? 0) + 1 }); }}
                    >
                      +
                    </button>
                  </div>
                </div>
                {account.lastResort ? (
                  <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>
                    only when everything else is spent
                  </span>
                ) : null}
              </div>
            )}
            {patchErrors[account.id] ? (
              <span role="alert" style={{ gridColumn: '1/-1', fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{patchErrors[account.id]}</span>
            ) : null}
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

      {/* Unlinking keeps the login's files, so they need somewhere to be seen and a way
          out. Deleting is irreversible and large, so it names the size and asks once --
          and it never travels a path, only the directory's own name. */}
      {leftovers.length > 0 ? (
        <div data-testid="leftovers" style={{ borderTop: '1px solid var(--line)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h6 className="sec">Unlinked logins still on disk <span className="n">{leftovers.length}</span></h6>
          {leftovers.map((leftover) => (
            <div
              key={leftover.name} data-testid={`leftover-${leftover.name}`}
              style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-meta)' }}
            >
              <span style={{ color: 'var(--ink2)' }}>{leftover.name}</span>
              <span style={{ color: 'var(--ink3)' }}>{sizeWords(leftover.bytes)}</span>
              {confirmingLeftover?.name === leftover.name ? (
                <>
                  <span style={{ color: 'var(--warn)' }}>{`Delete ${sizeWords(leftover.bytes)} for good?`}</span>
                  <span style={{ color: 'var(--ink3)' }}>re-linking needs the browser</span>
                  <button
                    type="button" className="btn warn" style={{ padding: '4px 12px' }}
                    data-testid={`leftover-confirm-${leftover.name}`}
                    onClick={() => { void handleDeleteLeftover(leftover.name, confirmingLeftover.token); }}
                  >
                    Delete
                  </button>
                  <button type="button" className="btn ghost" style={{ padding: '4px 12px' }} onClick={() => setConfirmingLeftover(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button" className="btn" style={{ padding: '4px 12px' }}
                  data-testid={`leftover-delete-${leftover.name}`}
                  onClick={() => { void handleDeleteLeftover(leftover.name); }}
                >
                  Delete files
                </button>
              )}
            </div>
          ))}
          {leftoverError ? <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{leftoverError}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
