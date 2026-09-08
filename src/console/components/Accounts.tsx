import type { JSX } from 'react';
import { useState } from 'react';

import { hm } from '../freshness.js';
import type { AccountRow, AccountWindow, AccountsResponse } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';

export interface AccountsProps {
  accounts: AccountsResponse | null;
  now: number;
}

function windowColor(window: AccountWindow): string {
  if (window.status === 'rejected') return 'var(--block)';
  if (window.status === 'allowed_warning') return 'var(--park)';
  if (window.status === 'unavailable' || window.status === 'unknown') return 'var(--ink3)';
  return 'var(--run)';
}

function resetText(window: AccountWindow, now: number): string {
  if (window.resetsAt === null) return '';
  const minutes = Math.round((window.resetsAt - now) / 60_000);
  if (minutes <= 0) return 'resets now';
  if (minutes < 120) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours} h`;
  return `resets in ${Math.round(hours / 24)} d`;
}

/** One plan window as a labelled bar: the percent used, its colour by status, and when
 *  it resets. An unknown window says so instead of drawing an empty bar. */
function WindowBar({ label, window, now }: { label: string; window: AccountWindow; now: number }): JSX.Element {
  const pct = window.utilization === null ? null : Math.max(0, Math.min(100, window.utilization));
  const color = windowColor(window);
  const note = window.status === 'unavailable' ? 'plan windows not visible from this login'
    : window.status === 'unknown' ? 'not measured yet'
    : resetText(window, now);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }} data-testid={`window-${label.replace(/\s+/g, '-')}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span className="lbl" style={{ color: 'var(--ink3)' }}>{label}</span>
        <span className="m" style={{ fontSize: 12.5, fontWeight: 700, color }}>
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--well)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.5)', overflow: 'hidden' }}>
        <div style={{ width: `${pct ?? 0}%`, height: '100%', background: color, transition: 'width .3s' }} />
      </div>
      <span className="m" style={{ fontSize: 10, color: 'var(--ink3)' }}>{note}</span>
    </div>
  );
}

function connectedChip(row: AccountRow): JSX.Element {
  if (row.paused) {
    return <span className="chip" style={{ borderColor: 'var(--block)', color: 'var(--block)' }} data-testid="account-paused">paused</span>;
  }
  if (row.connected === 'yes') return <span className="chip" style={{ borderColor: 'var(--run)', color: 'var(--run)' }}>connected</span>;
  if (row.connected === 'no') return <span className="chip" style={{ borderColor: 'var(--block)', color: 'var(--block)' }}>not connected</span>;
  return <span className="chip">not checked</span>;
}

function AccountCard({ row, now }: { row: AccountRow; now: number }): JSX.Element {
  const paused = row.paused;
  return (
    <div className="plate" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }} data-testid={`account-${row.id}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className="m" style={{ fontSize: 14, fontWeight: 700 }}>{row.id}</span>
          <span className="chip">{row.provider === 'claude' ? (row.subscription ? `claude ${row.subscription}` : 'claude') : 'codex'}</span>
          {row.isLaunchAccount ? <span className="chip" style={{ borderColor: 'var(--hand)', color: 'var(--hand)' }}>launches go here</span> : null}
          {connectedChip(row)}
        </div>
        <span className="m" style={{ fontSize: 10.5, color: 'var(--ink3)' }}>
          {row.configDir ?? 'the harness tool login'}
        </span>
      </div>

      {row.connected === 'no' && row.connectedReason ? (
        <div className="m" style={{ fontSize: 11, color: 'var(--block)' }}>{row.connectedReason}</div>
      ) : null}
      {paused ? (
        <div className="m" style={{ fontSize: 11, color: 'var(--block)' }}>
          The {paused.window.replace('_', ' ')} window is full. Nothing new starts here until {hm(paused.until)}.
        </div>
      ) : null}

      {row.provider === 'claude' ? (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <WindowBar label="five hour" window={row.fiveHour} now={now} />
          <WindowBar label="seven day" window={row.sevenDay} now={now} />
        </div>
      ) : (
        <div className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>
          {row.codex
            ? `${row.codex.callsToday} call${row.codex.callsToday === 1 ? '' : 's'} today, ${Math.round(row.codex.durationTodayMs / 60_000)} min in total`
              + (row.codex.lastCallAt ? `, last at ${hm(row.codex.lastCallAt)}` : '')
            : 'No ledger to read.'}
          {row.codex?.lastError ? <span style={{ color: 'var(--block)' }}> · last call failed: {row.codex.lastError}</span> : null}
          <div style={{ color: 'var(--ink3)', marginTop: 4 }}>Codex has no usage API; this is the harness tool's own ledger.</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>
          <b style={{ color: 'var(--ink)' }}>{row.liveRuns}</b> live run{row.liveRuns === 1 ? '' : 's'}
          {row.maxConcurrent ? <span style={{ color: 'var(--ink3)' }}> of {row.maxConcurrent}</span> : null}
        </span>
        {row.provider === 'claude' ? (
          <span className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>
            <b style={{ color: 'var(--ink)' }}>{fmtTokens(row.tokensToday)}</b> tokens today
          </span>
        ) : null}
        {row.lastEvent ? (
          <span className="m" style={{ fontSize: 10.5, color: 'var(--ink3)' }}>
            last signal {hm(row.lastEvent.at)} from {row.lastEvent.actor === 'probe' ? 'the probe' : 'a run'}
            {row.lastEvent.window ? `, ${row.lastEvent.window.replace('_', ' ')} ${row.lastEvent.status.replace('_', ' ')}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Connect panel: the exact commands for the next Claude config dir. The console runs
 *  none of them; the browser login is the operator's own. The path is built from the
 *  server's reported home directory so nothing here guesses a machine's layout. */
function ConnectPanel({ accounts }: { accounts: AccountsResponse }): JSX.Element {
  const claudeIds = accounts.accounts.filter((a) => a.provider === 'claude').map((a) => a.id);
  const suffixes = ['b', 'c', 'd', 'e'];
  const next = suffixes.find((s) => !claudeIds.includes(`fleet-${s}`)) ?? `${claudeIds.length + 1}`;
  const [id, setId] = useState(`fleet-${next}`);
  const dir = `${accounts.homeDir.replace(/\\/g, '/')}/.claude-${id}`;
  const login = `CLAUDE_CONFIG_DIR=${dir} claude`;
  const add = `npm run forge -- accounts add ${id} ${dir}`;
  return (
    <div className="plate" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="connect-panel">
      <span className="lbl" style={{ color: 'var(--ink2)' }}>Connect another Claude account</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>Name it</span>
        <input
          className="inp m" value={id} onChange={(e) => setId(e.target.value.replace(/[^a-z0-9._-]/gi, ''))}
          style={{ flex: 'none', width: 120, border: '1px solid var(--line2)', borderRadius: 3, padding: '4px 8px', fontSize: 12, color: 'var(--ink)' }}
          aria-label="new account id"
        />
      </div>
      <ol className="m" style={{ fontSize: 11.5, color: 'var(--ink2)', margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.5 }}>
        <li>
          In a terminal, start Claude Code under a fresh config dir and log in there (the browser flow is yours):
          <pre className="m" style={{ margin: '4px 0 0', padding: '8px 10px', background: 'var(--well)', color: '#dde3d0', borderRadius: 3, fontSize: 11, overflowX: 'auto' }} data-testid="connect-login-command">
            {login}{'\n'}/login
          </pre>
        </li>
        <li>
          Register it. This asks that login for its plan windows through the SDK and refuses a dir that does not answer:
          <pre className="m" style={{ margin: '4px 0 0', padding: '8px 10px', background: 'var(--well)', color: '#dde3d0', borderRadius: 3, fontSize: 11, overflowX: 'auto' }} data-testid="connect-add-command">
            {add}
          </pre>
        </li>
        <li>Restart the console server so the probe picks it up, then this page shows the new row.</li>
      </ol>
      <span className="m" style={{ fontSize: 10, color: 'var(--ink3)' }}>
        Your own login stays where it is. The registry refuses a dir equal to your interactive config dir.
      </span>
    </div>
  );
}

export function Accounts({ accounts, now }: AccountsProps): JSX.Element {
  if (!accounts) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <span className="lbl" style={{ color: 'var(--ink2)' }}>Reading accounts…</span>
      </div>
    );
  }
  const claude = accounts.accounts.filter((a) => a.provider === 'claude');
  const probeLine = accounts.probe.on
    ? `Probe on, every ${Math.round(accounts.probe.everySeconds / 60)} min${accounts.probe.lastAt ? `, last at ${hm(accounts.probe.lastAt)}` : ', not run yet'}.`
    : 'Probe off (FORGE_ACCOUNTS_PROBE=1 turns it on). Windows update only when a run reports one.';
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="accounts-view">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span className="lbl" style={{ color: 'var(--ink2)' }}>
          {claude.length} Claude account{claude.length === 1 ? '' : 's'} and {accounts.accounts.length - claude.length} Codex
        </span>
        <span className="m" style={{ fontSize: 10.5, color: 'var(--ink3)' }} data-testid="probe-line">{probeLine}</span>
      </div>
      {accounts.registrySource === 'invalid' ? (
        <div className="m" style={{ fontSize: 11, color: 'var(--block)' }} data-testid="registry-error">
          {accounts.registryPath} was ignored: {accounts.registryError}. Showing the built-in single account until it is fixed.
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 14 }}>
        {accounts.accounts.map((row) => <AccountCard key={row.id} row={row} now={now} />)}
      </div>
      {accounts.unattributedTokensToday > 0 ? (
        <span className="m" style={{ fontSize: 10.5, color: 'var(--ink3)' }}>
          {fmtTokens(accounts.unattributedTokensToday)} tokens today came from runs that started before accounts were recorded.
        </span>
      ) : null}
      <ConnectPanel accounts={accounts} />
      <span className="m" style={{ fontSize: 10, color: 'var(--ink3)' }}>
        Registry: {accounts.registryPath}{accounts.registrySource === 'default' ? ' (not written yet; the single built-in account)' : ''}.
        Routing is unchanged: every launch still goes to the account marked above.
      </span>
    </div>
  );
}
