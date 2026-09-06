import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import * as api from '../api.js';
import { HOP_NAMES } from '../../shared/console-model.js';
import { capText, costClass, ctxPercent, laneCta, laneHeadline, stateOf } from '../laneVM.js';
import { computeFreshness, freshnessClass, freshnessStamp } from '../freshness.js';
import type { Lane, Message } from '../../shared/console-model.js';

export interface TicketSheetProps {
  lane: Lane;
  feedLive: boolean;
  now: number;
  onClose: () => void;
  onCommand: (id: string, cmd: string) => void;
  onOpenCost: (id: string) => void;
  onOpenSandbox: (id: string) => void;
  onSendLane: (id: string, text: string) => void;
}

/** Ticket sheet: band, id/model/repo/attempt, cost, context, pipeline rail, journal, run thread. */
export function TicketSheet(props: TicketSheetProps): JSX.Element {
  const { lane, feedLive, now, onClose, onCommand, onOpenCost, onOpenSandbox, onSendLane } = props;
  const [thread, setThread] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let active = true;
    api.getRunThread(lane.id).then((r) => { if (active) setThread(r.messages); }).catch(() => undefined);
    return () => { active = false; };
  }, [lane.id]);

  const st = stateOf(lane.state);
  const headline = laneHeadline(lane);
  const cta = laneCta(lane);
  const pct = ctxPercent(lane);
  const fresh = computeFreshness(lane.verifiedAt, lane.observedAt, feedLive, now);
  const canPause = lane.state === 'running' || lane.state === 'handed-off';
  const canKill = lane.state === 'running' || lane.state === 'handed-off' || lane.state === 'parked';
  // The run's own report (its reply cards) plus what the console did to it
  // (receipt cards); the run thread on the right keeps every message type.
  const journalItems = thread.filter((m) => m.type === 'reply' || m.type === 'receipt');

  return (
    <div className="plate" data-testid="ticket-sheet" style={{ width: 900, maxWidth: 'calc(100vw - 40px)', borderColor: 'var(--line2)' }}>
      <div className="lbl" style={{ background: st.color, color: 'var(--aInk)', padding: '7px 20px', display: 'flex', justifyContent: 'space-between', gap: 12, borderRadius: '3px 3px 0 0' }}>
        <span>{st.label} since {new Date(lane.since).toLocaleTimeString()}</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose}>esc to close ✕</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, whiteSpace: 'nowrap' }}>
          <div>
            <span className="m" style={{ fontSize: 22, fontWeight: 700 }}>{headline.main}</span>
            {headline.sub ? (
              <div className="m" title={headline.sub} style={{ fontSize: '10.5px', color: 'var(--ink3)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {headline.sub}
              </div>
            ) : null}
          </div>
          <span className="chip">{lane.model}</span>
          <span className="chip">{lane.repo}</span>
          <span className="chip">attempt {lane.attempt}</span>
          <a className="m" style={{ fontSize: '10.5px' }} onClick={() => onOpenSandbox(lane.id)}>{lane.sandbox?.id ?? '--'}</a>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'right' }}>
            <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 3 }}>cost</div>
            <span className={costClass(lane)} onClick={() => onOpenCost(lane.id)}>${lane.costUsd.toFixed(2)}</span>
          </div>
          <div style={{ width: 140 }}>
            <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 4 }}>context {pct}% · ceiling {Math.round(lane.ctxCeiling / 1000)}k</div>
            <div style={{ height: 8, background: 'var(--well)', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.6)', borderRight: '3px solid var(--block)', borderRadius: 2 }}>
              <div style={{ height: 6, margin: 1, width: `${pct}%`, background: `repeating-linear-gradient(90deg, ${st.color} 0 5px, transparent 5px 7px)` }} />
            </div>
          </div>
          <span className={freshnessClass(fresh)}>{freshnessStamp(fresh)}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <span className={cta.cls} style={{ padding: '7px 11px', fontSize: '9.5px' }} onClick={() => onCommand(lane.id, cta.cmd)}>{cta.label}</span>
            {canPause ? <span className="btnS" style={{ padding: '7px 11px', fontSize: '9.5px' }} onClick={() => onCommand(lane.id, 'pause')}>Pause</span> : null}
            {canKill ? <span className="btnR" style={{ padding: '7px 11px', fontSize: '9.5px' }} onClick={() => onCommand(lane.id, 'kill')}>Kill</span> : null}
          </div>
        </div>
      </div>
      <div style={{ padding: '20px 22px', borderBottom: '1px solid var(--line)' }}>
        <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 16 }}>Pipeline</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowX: 'auto' }}>
          {HOP_NAMES.map((name, i) => {
            const hopIndex = i as 0 | 1 | 2 | 3 | 4 | 5;
            const state = hopIndex < lane.hop ? 'done' : hopIndex === lane.hop ? lane.hopStatus : 'ghost';
            const color = state === 'done' ? 'var(--run)' : state === 'blocked' ? 'var(--block)' : state === 'live' ? 'var(--hand)' : 'var(--line2)';
            const glyph = state === 'done' ? '✓' : state === 'blocked' ? '■' : state === 'live' ? '●' : '';
            return (
              <div key={name} style={{ display: 'contents' }}>
                {i > 0 ? <div style={{ width: 56, height: 2, background: 'var(--line2)', marginTop: 15 }} /> : null}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 112 }}>
                  <div style={{ width: 32, height: 32, border: `2px solid ${color}`, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '700 13px "IBM Plex Mono",monospace', color }}>{glyph}</div>
                  <div className="m" style={{ fontSize: '10.5px', fontWeight: 600, color, textAlign: 'center' }}>{name}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', minHeight: 300, flexWrap: 'wrap' }}>
        <div style={{ width: 340, flex: '1 1 300px', borderRight: '1px solid var(--line)', padding: '16px 22px' }}>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 10 }}>Journal</div>
          {journalItems.length === 0 ? (
            <div className="m" style={{ fontSize: 11, color: 'var(--ink3)' }}>no report yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {journalItems.map((m) => (
                <div key={m.k} className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)' }}>
                  {m.type === 'receipt' ? <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{m.jid} </span> : null}
                  {m.text}
                </div>
              ))}
            </div>
          )}
          {lane.reason ? <div className="m" style={{ fontSize: 11, color: 'var(--block)', marginTop: 12 }}>{lane.reason}</div> : null}
          {lane.pr ? (
            <>
              <div className="lbl" style={{ color: 'var(--ink2)', margin: '16px 0 8px' }}>Draft output</div>
              <div className="plate" style={{ padding: '10px 12px' }}>
                <a className="m" style={{ fontSize: '11.5px', fontWeight: 700 }} href={lane.pr.url}>draft PR #{lane.pr.no} ↗</a>
                <div className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', marginTop: 4 }}>
                  {lane.pr.files} files · <span style={{ color: 'var(--run)', fontWeight: 700 }}>+{lane.pr.add}</span> <span style={{ color: 'var(--block)', fontWeight: 700 }}>−{lane.pr.del}</span>
                </div>
              </div>
            </>
          ) : null}
        </div>
        <div style={{ flex: '2 1 380px', padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="lbl" style={{ color: 'var(--ink2)' }}>Run thread — {lane.id} only</div>
          {thread.map((m) => (
            <div key={m.k} className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)' }}>{m.text}</div>
          ))}
          <div style={{ marginTop: 'auto', background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '8px 8px 8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="inp" placeholder={`message ${lane.id}…`} value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { onSendLane(lane.id, draft); setDraft(''); } }}
            />
            <span className="btnP" style={{ padding: '5px 10px', fontSize: '9.5px' }} onClick={() => { if (draft.trim()) { onSendLane(lane.id, draft); setDraft(''); } }}>Send ⏎</span>
          </div>
        </div>
      </div>
      <div className="m" style={{ padding: '8px 22px', fontSize: '9.5px', color: 'var(--ink3)' }}>{capText(lane)}</div>
    </div>
  );
}
