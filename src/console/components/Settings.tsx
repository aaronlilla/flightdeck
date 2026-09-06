import type { JSX } from 'react';
import { useState } from 'react';

import type { Caps, Integration } from '../../shared/console-model.js';

export interface SettingsProps {
  integrations: Integration[];
  caps: Caps | null;
  journalCount: number;
  onCheck: (id: string) => void;
  onReconnect: (id: string) => void;
  onCheckAll: () => void;
  onSaveCaps: (dailyUsd: number, runUsd: number) => Promise<void> | void;
  onOpenJournal: () => void;
}

const STATUS_COLOR: Record<Integration['status'], string> = {
  ok: 'var(--run)', down: 'var(--block)', degraded: 'var(--park)', off: 'var(--ink3)', busy: 'var(--hand)', checking: 'var(--ink3)',
};

function ctaFor(i: Integration): string {
  if (i.status === 'down') return i.kind === 'mcp' ? 'Fix →' : (i.fixLabel ?? 'Reconnect →');
  if (i.status === 'degraded') return 'Restart';
  if (i.status === 'off') return 'Connect';
  return 'manage';
}

/** An MCP server runs over stdio, so a healthy row with no measured latency says so
 *  instead of the generic "--" a connection with nothing to report would print. */
function latencyDisplay(i: Integration): string {
  if (i.latencyMs !== null) return `${i.latencyMs} ms`;
  if (i.kind === 'mcp' && i.status === 'ok') return 'stdio';
  return '--';
}

function Row({ i, onCheck, onReconnect }: { i: Integration; onCheck: (id: string) => void; onReconnect: (id: string) => void }): JSX.Element {
  return (
    <div className="row">
      <span className="led" style={{ background: STATUS_COLOR[i.status] }} />
      <b>{i.name}</b>
      <span style={{ color: 'var(--ink2)' }}>{i.desc}</span>
      <span style={{ color: 'var(--ink2)' }}>{latencyDisplay(i)}</span>
      <span className={i.status === 'ok' ? 'stF' : 'stO'}>{i.status}</span>
      <span
        className="btnS" style={{ padding: '5px 10px', fontSize: '9.5px', justifySelf: 'end', textAlign: 'right' }}
        onClick={() => (i.status === 'down' ? onReconnect(i.id) : onCheck(i.id))}
      >
        {ctaFor(i)}
      </span>
    </div>
  );
}

/** Settings -> Integrations: down plate, connections table, MCP table, caps form, connection-loss policy. */
export function Settings(props: SettingsProps): JSX.Element {
  const { integrations, caps, journalCount, onCheck, onReconnect, onCheckAll, onSaveCaps, onOpenJournal } = props;
  const [dailyDraft, setDailyDraft] = useState(String(caps?.dailyUsd ?? ''));
  const [runDraft, setRunDraft] = useState(String(caps?.runUsd ?? ''));
  const [err, setErr] = useState('');

  const down = integrations.filter((i) => i.status === 'down');
  const conns = integrations.filter((i) => i.kind === 'conn');
  const mcps = integrations.filter((i) => i.kind === 'mcp');

  async function save(): Promise<void> {
    const daily = Number(dailyDraft);
    const run = Number(runDraft);
    if (!Number.isFinite(daily) || !Number.isFinite(run)) { setErr('caps must be numbers'); return; }
    if (caps && (daily > caps.hardUsd || run > caps.hardUsd)) { setErr(`refused above the org hard limit $${caps.hardUsd}`); return; }
    setErr('');
    await onSaveCaps(daily, run);
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }} data-testid="settings-view">
      <div className="scroll" style={{ flex: 1, padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {down.map((d) => (
          <div key={d.id} className="plate" style={{ border: '2px solid var(--block)', padding: 0 }}>
            <div className="lbl" style={{ background: 'var(--block)', color: 'var(--aInk)', padding: '7px 16px', display: 'flex', justifyContent: 'space-between' }}>
              <span>■ disconnected</span>
              <span>{d.dependents.length} lanes blocked · since {d.since ? new Date(d.since).toLocaleTimeString() : '--'}</span>
            </div>
            <div style={{ display: 'flex', gap: 22, padding: 16, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <span className="m" style={{ fontSize: 16, fontWeight: 700 }}>{d.name}</span>
                <div className="m" style={{ fontSize: '11.5px', lineHeight: 1.9, color: 'var(--ink2)', marginTop: 8 }}>
                  <b style={{ color: 'var(--ink)' }}>cause</b> {d.cause}<br />
                  <b style={{ color: 'var(--ink)' }}>effect</b> {d.effect}<br />
                  <b style={{ color: 'var(--ink)' }}>fix</b> {d.fix}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', width: 230 }}>
                <span className="btnR" style={{ padding: 12, fontSize: 12 }} onClick={() => onReconnect(d.id)}>{d.fixLabel ?? 'Reconnect via SSO'} →</span>
                <span className="btnS">Paste credentials</span>
                <span className="m" style={{ fontSize: '9.5px', color: 'var(--ink3)', textAlign: 'center' }}>≈ 20 s · no restart</span>
              </div>
            </div>
          </div>
        ))}
        <div className="plate" style={{ padding: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
            <span className="lbl">Connections</span>
            <span className="m" style={{ fontSize: 10, color: 'var(--ink2)' }}>checked every 30s · <a onClick={onCheckAll}>check now</a></span>
          </div>
          <div className="m" style={{ fontSize: '11.5px' }}>
            {conns.map((i) => <Row key={i.id} i={i} onCheck={onCheck} onReconnect={onReconnect} />)}
          </div>
        </div>
        <div className="plate" style={{ padding: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
            <span className="lbl">MCP servers</span>
          </div>
          <div className="m" style={{ fontSize: '11.5px' }}>
            {mcps.map((i) => <Row key={i.id} i={i} onCheck={onCheck} onReconnect={onReconnect} />)}
          </div>
        </div>
      </div>
      <div style={{ width: 300, borderLeft: '1px solid var(--line)', padding: '22px 20px', background: 'var(--panel)', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 8 }}>Caps &amp; policies</div>
          <div className="m" style={{ fontSize: '11.5px', lineHeight: 2.4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ink2)' }}>daily cap</span>
              <span>$<input className="inp m" style={{ width: 50, fontSize: 12, fontWeight: 700, textAlign: 'right' }} value={dailyDraft} onChange={(e) => setDailyDraft(e.target.value)} /></span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ink2)' }}>per-run cap</span>
              <span>$<input className="inp m" style={{ width: 50, fontSize: 12, fontWeight: 700, textAlign: 'right' }} value={runDraft} onChange={(e) => setRunDraft(e.target.value)} /></span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink2)' }}>org hard limit</span><b>${caps?.hardUsd ?? 0} · FD-7</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink2)' }}>cap enforcement</span><span style={{ fontWeight: 700 }}>{caps?.enforcement ?? 'off'}</span></div>
          </div>
          <span className="btnP" style={{ width: '100%', marginTop: 6 }} onClick={() => void save()}>Save caps →</span>
          <div className="m" style={{ fontSize: 10, color: 'var(--block)', marginTop: 6, minHeight: 14 }}>{err}</div>
        </div>
        <div>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 8 }}>On connection loss</div>
          <div className="m" style={{ fontSize: 11, lineHeight: 1.9, color: 'var(--ink2)' }}>
            Needs-you strip within 30s, with fix button<br />
            Dependent lanes hold, do not fail<br />
            2 auto-retries, then operator<br />
            No irreversible action while a dependency is down
          </div>
        </div>
        <div>
          <a className="m" style={{ fontSize: '11.5px' }} onClick={onOpenJournal}>Audit journal <span className="chip" style={{ fontSize: 8 }}>{journalCount}</span></a>
        </div>
      </div>
    </div>
  );
}
