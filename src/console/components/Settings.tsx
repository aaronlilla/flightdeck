import type { JSX } from 'react';
import { useState } from 'react';

import { ACTIONS, useAction } from '../actions.js';
import { durationWords } from '../laneVM.js';
import type { AccountItem, Caps, Integration } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import { Accounts } from './Accounts.js';
import { NarratedLine } from './Narrated.js';
import { Marks } from './QuestionCard.js';
import { IntegrationsPanel } from './IntegrationsPanel.js';

/**
 * `Flightdeck Console.dc.html` 1e: AI accounts, data sources with live reachability,
 * MCP servers, the width stepper, the daily cap, and the theme. Every control is
 * labelled in words; no environment variable name appears.
 */
export interface SettingsProps {
  integrations: Integration[];
  /** The Claude accounts runs launch under. Empty means the fleet login is used. */
  accounts: AccountItem[];
  /** Refetches the accounts slice after a connect or disconnect. */
  onAccountsChanged?: () => void;
  caps: Caps | null;
  now: number;
  maxInFlight: number;
  theme: 'light' | 'dark';
  onTheme: (theme: 'light' | 'dark') => void;
  /** `?verbose=1`: every row's fact record under its sentence. */
  verbose?: boolean;
}

/**
 * The colours and the freshness suffix -- everything about a row that is not a sentence.
 * The two sentences themselves come from the server as `row.words`, narrated, so the tile
 * and the model can never end up describing the same row from two different copies of
 * this switch. The "checked X ago" phrase is composed here on purpose: it is the clock,
 * and a clock inside a narration fact would move the cache key once a second.
 */
function statusLook(row: Integration, now: number): { color: string; dot: string; down: boolean; freshness: string } {
  const checked = ` · checked ${durationWords(now - row.checkedAt)} ago`;
  switch (row.status) {
    case 'ok':
      return { color: 'var(--ink)', dot: 'var(--acc)', down: false, freshness: checked };
    case 'down':
      return { color: 'var(--warn)', dot: 'var(--warn)', down: true, freshness: '' };
    case 'degraded':
      return { color: 'var(--warn)', dot: 'var(--warn)', down: false, freshness: checked };
    case 'off':
      return { color: 'var(--ink3)', dot: 'var(--ink3)', down: false, freshness: '' };
    case 'checking':
    case 'busy':
      return { color: 'var(--ink2)', dot: 'var(--ink3)', down: false, freshness: '' };
    default:
      return { color: 'var(--ink2)', dot: 'var(--ink3)', down: false, freshness: '' };
  }
}

function SourceRow({ row, now, verbose }: { row: Integration; now: number; verbose?: boolean }): JSX.Element {
  const check = useAction(ACTIONS.checkIntegration, row.id);
  const reconnect = useAction(ACTIONS.reconnectIntegration, row.id);
  const look = statusLook(row, now);
  const fixable = look.down && row.canConnect;
  const busy = check.pending || reconnect.pending;
  const result = reconnect.result?.kind === 'done' ? reconnect.result : check.result?.kind === 'done' ? check.result : null;
  return (
    <div data-testid={`source-${row.id}`} style={{ position: 'relative', border: `1px solid ${look.down ? 'var(--warn)' : 'var(--line)'}`, padding: '14px 18px', display: 'grid', gridTemplateColumns: '150px 1fr auto', gap: 18, alignItems: 'center', background: look.down ? 'var(--warnTint)' : 'transparent' }}>
      <Marks />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><i style={{ width: 10, height: 10, background: look.dot, display: 'block', flex: 'none' }} /><span className="hd" style={{ fontSize: 'var(--fs-heading)' }}>{row.name}</span></div>
      <div>
        <div style={{ color: look.color, fontWeight: 500 }}><NarratedLine bag={row.narration} field="status" glance={row.words.status} testid="source-status" {...(verbose === undefined ? {} : { verbose })} /></div>
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{result ? result.text : <><NarratedLine bag={row.narration} field="note" glance={row.words.note} testid="source-note" {...(verbose === undefined ? {} : { verbose })} />{look.freshness}</>}</div>
      </div>
      <button type="button" className={`btn ${fixable ? 'warn' : ''}`} aria-busy={busy} style={{ padding: '6px 14px' }} onClick={() => void (fixable ? reconnect.run(row.id) : check.run(row.id))}>
        {busy ? 'Checking…' : fixable ? (row.fixLabel ?? 'Reconnect') : 'Check now'}
      </button>
    </div>
  );
}

function capInput(value: number): string {
  return Number.isFinite(value) ? fmtTokens(value) : '';
}

export function Settings({ integrations, accounts, onAccountsChanged, caps, now, maxInFlight, theme, onTheme, verbose }: SettingsProps): JSX.Element {
  const width = useAction(ACTIONS.postQueueWidth);
  const save = useAction(ACTIONS.setCaps);
  const [daily, setDaily] = useState<string | null>(null);
  const shown = daily ?? (caps ? capInput(caps.dailyTokens) : '');
  const setWidth = (value: number): void => { if (value >= 1 && value <= 12) void width.run(value); };
  const [capError, setCapError] = useState<string | null>(null);
  const parseTokens = (text: string): number | null => {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(text);
    if (!match) return null;
    const unit = (match[2] ?? '').toLowerCase();
    return Math.round(Number(match[1]) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
  };
  const saveCap = (): void => {
    const value = parseTokens(shown);
    if (value === null) { setCapError(`"${shown.trim()}" — use a number like 40M`); return; }
    setCapError(null);
    void save.run({ dailyTokens: value }).then((outcome) => { if (outcome.kind === 'confirm') void save.confirm(); setDaily(null); });
  };
  const used = caps?.tokensToday ?? 0;
  const cap = caps && Number.isFinite(caps.dailyTokens) ? caps.dailyTokens : null;
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <main data-testid="settings" className="scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '26px 28px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, alignContent: 'start' }}>
      <Accounts accounts={accounts} now={now} onChanged={onAccountsChanged} />

      <section style={{ display: 'flex', flexDirection: 'column', gap: 10, gridColumn: '1/-1' }}>
        <h6 className="sec">Data sources</h6>
        {integrations.filter((row) => row.kind !== 'mcp').map((row) => <SourceRow key={row.id} row={row} now={now} {...(verbose === undefined ? {} : { verbose })} />)}
      </section>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10, gridColumn: '1/-1' }}>
        <h6 className="sec">MCP servers</h6>
        <IntegrationsPanel items={integrations.filter((row) => row.kind === 'mcp')} now={now} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 28, gridColumn: '1/-1' }}>
        <section style={{ position: 'relative', border: '1px solid var(--line)', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Marks />
          <h6 className="sec">Agents</h6>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <label style={{ fontSize: 'var(--fs-body)' }}>At once</label>
            <div className="step" data-testid="settings-width">
              <button type="button" aria-label="one fewer" onClick={() => setWidth(maxInFlight - 1)}>−</button>
              <span>{maxInFlight}</span>
              <button type="button" aria-label="one more" onClick={() => setWidth(maxInFlight + 1)}>+</button>
            </div>
          </div>
          {width.result?.kind === 'done' ? <span style={{ fontSize: 'var(--fs-meta)', color: width.result.ok ? 'var(--ink3)' : 'var(--warn)' }}>{width.result.text}</span> : null}
        </section>
        <section style={{ position: 'relative', border: '1px solid var(--line)', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Marks />
          <h6 className="sec">Daily spend cap</h6>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="daily-cap" style={{ fontSize: 'var(--fs-body)' }}>Tokens</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="daily-cap" className="inp hd" style={{ width: 120, flex: 'none', minHeight: 36, fontSize: 'var(--fs-title)' }} value={shown} onChange={(e) => setDaily(e.target.value)} onBlur={saveCap} onKeyDown={(e) => { if (e.key === 'Enter') saveCap(); }} />
              <div className="seg" aria-label="What happens at the cap" data-testid="cap-enforcement">
                <span style={{ padding: '7px 12px', fontSize: 'var(--fs-ui)', ...(caps?.enforcement === 'on' ? { background: 'var(--acc)', color: 'var(--accInk)' } : { color: 'var(--ink2)' }) }}>Stop new work at the cap</span>
                <span style={{ padding: '7px 12px', fontSize: 'var(--fs-ui)', borderLeft: '1px solid var(--line2)', ...(caps?.enforcement === 'off' ? { background: 'var(--acc)', color: 'var(--accInk)' } : { color: 'var(--ink2)' }) }}>Warn only</span>
              </div>
            </div>
            {capError ? <span data-testid="cap-error" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{capError}</span> : null}
            {save.result?.kind === 'done' ? <span style={{ fontSize: 'var(--fs-meta)', color: save.result.ok ? 'var(--ink3)' : 'var(--warn)' }}>{save.result.text}</span> : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{fmtTokens(used)} used today</span><span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>resets at midnight</span></div>
            <div style={{ height: 6, border: '1px solid var(--line2)', position: 'relative' }}><div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${pct}%`, background: 'var(--acc)' }} /></div>
          </div>
        </section>
        <section style={{ position: 'relative', border: '1px solid var(--line)', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Marks />
          <h6 className="sec">Theme</h6>
          <div className="seg" role="group" aria-label="Theme">
            <button type="button" data-testid="theme-light" aria-pressed={theme === 'light'} onClick={() => onTheme('light')}>Light</button>
            <button type="button" data-testid="theme-dark" aria-pressed={theme === 'dark'} onClick={() => onTheme('dark')}>Dark</button>
          </div>
        </section>
      </div>
    </main>
  );
}
