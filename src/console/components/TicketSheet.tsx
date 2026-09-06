import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

import * as api from '../api.js';
import { HOP_NAMES } from '../../shared/console-model.js';
import { costClass, ctxPercent, laneCta, laneHeadline, stateOf } from '../laneVM.js';
import { computeFreshness, freshnessClass, freshnessStamp, hm } from '../freshness.js';
import { MessageCard } from './ConductorRail.js';
import type { JournalNarrativeEntry, Lane, Message } from '../../shared/console-model.js';

export interface TicketSheetProps {
  lane: Lane;
  feedLive: boolean;
  now: number;
  onClose: () => void;
  onCommand: (id: string, cmd: string) => void;
  onOpenCost: (id: string) => void;
  onOpenSandbox: (id: string) => void;
  /** May return a promise (App's `runAction` does): the sheet awaits it before
   *  re-fetching its own run thread, since the thread it already holds was fetched
   *  once on open and a send otherwise never appears in it until the sheet is
   *  closed and reopened. */
  onSendLane: (id: string, text: string) => void | Promise<void>;
  onUndo: (jid: string) => void;
  onOpenJournal: (jid: string) => void;
}

interface HopStyle {
  border: 'solid' | 'dashed';
  color: string;
  bg: string;
  glyph: string;
  glyphColor: string;
  labelColor: string;
  badge: string;
  anim: string;
}

/** One entry per hop state, matching the prototype's own `HS` table (`hops()`,
 *  `script_wrapped.txt` ~206-212): a done/merged/blocked node is a solid filled disc, a
 *  live/parked node is a pulsing outlined ring, and a ghost node is a dashed empty ring. */
const HOP_STYLE: Record<'done' | 'merged' | 'live' | 'blocked' | 'parked' | 'ghost', HopStyle> = {
  done: { border: 'solid', color: 'var(--run)', bg: 'var(--run)', glyph: '✓', glyphColor: 'var(--bg)', labelColor: 'var(--ink)', badge: '', anim: 'none' },
  merged: { border: 'solid', color: 'var(--merge)', bg: 'var(--merge)', glyph: '⇗', glyphColor: 'var(--bg)', labelColor: 'var(--ink)', badge: 'merged', anim: 'none' },
  live: { border: 'solid', color: 'var(--hand)', bg: 'transparent', glyph: '●', glyphColor: 'var(--hand)', labelColor: 'var(--ink)', badge: 'live', anim: 'fdring 1.8s ease-out infinite' },
  blocked: { border: 'solid', color: 'var(--block)', bg: 'var(--block)', glyph: '■', glyphColor: 'var(--aInk)', labelColor: 'var(--ink)', badge: 'blocked', anim: 'none' },
  parked: { border: 'solid', color: 'var(--park)', bg: 'transparent', glyph: '◆', glyphColor: 'var(--park)', labelColor: 'var(--ink)', badge: 'parked', anim: 'fdpulse 1.4s steps(2,jump-none) infinite' },
  ghost: { border: 'dashed', color: 'var(--line2)', bg: 'transparent', glyph: '', glyphColor: 'var(--ink3)', labelColor: 'var(--ink3)', badge: '', anim: 'none' },
};

/** A hop's sub-label: the queue, the sandbox id, the model, the fixed council-judge
 *  count, or the merge target -- exactly `hops()`'s own `names` table. */
function hopSubLabel(index: number, lane: Lane): string {
  switch (index) {
    case 0: return 'queue';
    case 1: return lane.sandbox?.id ?? '';
    case 2: return lane.model;
    case 3: return 'council judge ×3';
    case 4: return lane.pr ? `PR #${lane.pr.no} → main` : '';
    default: return '';
  }
}

/** A hop's resolved state: `hops()`'s own resolution -- a merged lane fills only its
 *  merge hop, a paused lane's current hop reads as ghost rather than whatever
 *  `hopStatus` says, and every hop before the current one is always done. */
function hopState(index: number, lane: Lane): keyof typeof HOP_STYLE {
  if (lane.state === 'merged') return index === 4 ? 'merged' : 'done';
  if (index < lane.hop) return 'done';
  if (index === lane.hop) {
    if (lane.state === 'parked') return 'parked';
    if (lane.state === 'paused') return 'ghost';
    return lane.hopStatus;
  }
  return 'ghost';
}

/** The band's text, background and text color: `hops()`'s sibling logic in the
 *  prototype (script_wrapped.txt ~273-274) -- a parked lane always reads "parked --
 *  human needed since HH:MM"; an over-cap running lane reads its state plus " -- over
 *  cap, retry loop" on a red band; everything else is bare glyph + label with no time
 *  appended at all. */
function bandFor(lane: Lane): { text: string; bg: string; ink: string } {
  const st = stateOf(lane.state);
  const overCap = lane.capUsd !== null && lane.costUsd > lane.capUsd && lane.state === 'running';
  if (lane.state === 'parked') {
    return { text: `◆ parked — human needed since ${hm(lane.since)}`, bg: 'var(--park)', ink: 'var(--aInk)' };
  }
  const suffix = lane.runaway && lane.state === 'running' ? ' — over cap, retry loop' : '';
  return {
    text: `${st.glyph} ${st.label}${suffix}`,
    bg: overCap ? 'var(--block)' : 'var(--panel2)',
    ink: overCap ? 'var(--aInk)' : 'var(--ink2)',
  };
}

function JournalPanel({ entries }: { entries: JournalNarrativeEntry[] }): JSX.Element {
  return (
    <div className="m" style={{ fontSize: 11, lineHeight: 2, color: 'var(--ink2)' }}>
      {entries.map((entry, i) => (
        <div key={i}>
          <span style={{ color: entry.color, fontWeight: 600 }}>{hm(entry.t)}</span> <span>{entry.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Ticket sheet: band, id/model/repo/attempt, cost, context, pipeline rail, journal, run thread. */
export function TicketSheet(props: TicketSheetProps): JSX.Element {
  const { lane, feedLive, now, onClose, onCommand, onOpenCost, onOpenSandbox, onSendLane, onUndo, onOpenJournal } = props;
  const [thread, setThread] = useState<Message[]>([]);
  const [journal, setJournal] = useState<JournalNarrativeEntry[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let active = true;
    api.getRunThread(lane.id).then((r) => { if (active) setThread(r.messages); }).catch(() => undefined);
    api.getRunJournal(lane.id).then((r) => { if (active) setJournal(r.entries); }).catch(() => undefined);
    return () => { active = false; };
  }, [lane.id]);

  // A send lands on the run's own thread server-side, but the thread above was fetched
  // once on open and never polls -- without this, the message the operator just typed
  // would silently vanish from the sheet until it was closed and reopened.
  const sendAndRefetch = useCallback((text: string) => {
    Promise.resolve(onSendLane(lane.id, text))
      .then(() => api.getRunThread(lane.id))
      .then((r) => setThread(r.messages))
      .catch(() => undefined);
  }, [onSendLane, lane.id]);

  const headline = laneHeadline(lane);
  const cta = laneCta(lane);
  const pct = ctxPercent(lane);
  const fresh = computeFreshness(lane.verifiedAt, lane.observedAt, feedLive, now);
  const canPause = (lane.state === 'running' || lane.state === 'handed-off') && !lane.runaway;
  const canKill = (lane.state === 'running' || lane.state === 'handed-off' || lane.state === 'paused') && !lane.runaway;
  const band = bandFor(lane);

  return (
    <div className="plate" data-testid="ticket-sheet" style={{ width: 900, maxWidth: 'calc(100vw - 40px)', borderColor: 'var(--line2)' }}>
      <div className="lbl" style={{ background: band.bg, color: band.ink, padding: '7px 20px', display: 'flex', justifyContent: 'space-between', gap: 12, borderRadius: '3px 3px 0 0' }}>
        <span>{band.text}</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose}>esc to close ✕</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, whiteSpace: 'nowrap' }}>
          <span className="m" title={headline.runId} style={{ fontSize: 22, fontWeight: 700 }}>{headline.main}</span>
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
            <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 4 }}>context {pct}% · ceiling 200k</div>
            <div style={{ height: 8, background: 'var(--well)', boxShadow: 'inset 0 1px 3px rgba(0,0,0,.6)', borderRight: '3px solid var(--block)', borderRadius: 2 }}>
              <div style={{ height: 6, margin: 1, width: `${pct}%`, background: `repeating-linear-gradient(90deg, ${stateOf(lane.state).color} 0 5px, transparent 5px 7px)` }} />
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
            const state = hopState(i, lane);
            const style = HOP_STYLE[state];
            const sub = hopSubLabel(i, lane);
            return (
              <div key={name} style={{ display: 'contents' }}>
                {i > 0 ? <div style={{ width: 56, height: 2, background: 'var(--line2)', marginTop: 15 }} /> : null}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 112 }}>
                  <div style={{
                    width: 32, height: 32, borderWidth: 2, borderStyle: style.border, borderColor: style.color,
                    background: style.bg, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    font: '700 13px "IBM Plex Mono",monospace', color: style.glyphColor, animation: style.anim,
                  }}
                  >
                    {style.glyph}
                  </div>
                  <div className="m" style={{ fontSize: '10.5px', fontWeight: 600, color: style.labelColor, textAlign: 'center' }}>{name}</div>
                  {sub ? <div className="m" style={{ fontSize: 9, color: 'var(--ink3)', textAlign: 'center' }}>{sub}</div> : null}
                  {style.badge ? <span className="lbl" style={{ color: style.color }}>{style.badge}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', minHeight: 300, flexWrap: 'wrap' }}>
        <div style={{ width: 340, flex: '1 1 300px', borderRight: '1px solid var(--line)', padding: '16px 22px' }}>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 10 }}>Journal</div>
          <JournalPanel entries={journal} />
          {lane.pr ? (
            <>
              <div className="lbl" style={{ color: 'var(--ink2)', margin: '16px 0 8px' }}>Draft output</div>
              <div className="plate" style={{ padding: '10px 12px' }}>
                <a className="m" style={{ fontSize: '11.5px', fontWeight: 700 }}>draft PR #{lane.pr.no} ↗</a>
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
            <MessageCard
              key={m.k} message={m} feedLive={feedLive} now={now}
              onCommand={(text) => onCommand(lane.id, text)} onUndo={onUndo}
              onOpenJournal={onOpenJournal}
            />
          ))}
          <div style={{ marginTop: 'auto', background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '8px 8px 8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="inp" placeholder={`message ${lane.id}…`} value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { sendAndRefetch(draft); setDraft(''); } }}
            />
            <span className="btnP" style={{ padding: '5px 10px', fontSize: '9.5px' }} onClick={() => { if (draft.trim()) { sendAndRefetch(draft); setDraft(''); } }}>Send ⏎</span>
          </div>
        </div>
      </div>
    </div>
  );
}
