import type { JSX, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from '../api.js';
import { HOP_NAMES } from '../../shared/console-model.js';
import { costClass, ctxPercent, kindLabel, laneCta, laneHeadline, stateOf } from '../laneVM.js';
import { computeFreshness, freshnessClass, freshnessStamp, hm } from '../freshness.js';
import { MessageCard } from './ConductorRail.js';
import type { JournalNarrativeEntry, Lane, LaneStory, LaneSummary, Message } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';

export interface TicketSheetProps {
  lane: Lane;
  feedLive: boolean;
  now: number;
  /** Sweep #8: "View council" opens this sheet with nothing pointing at the council
   *  content it promised -- set when the sheet was opened from that CTA specifically,
   *  so the sheet can scroll to and highlight the audit line rather than leaving the
   *  operator to find it themselves. */
  focus?: 'audit';
  onClose: () => void;
  onCommand: (id: string, cmd: string) => void;
  onOpenCost: (id: string) => void;
  onOpenSandbox: (id: string) => void;
  /** May return a promise (App's `runAction` does): the sheet awaits it before
   *  re-fetching its own run thread, since the thread it already holds was fetched
   *  once on open and a send otherwise never appears in it until the sheet is
   *  closed and reopened. */
  onSendLane: (id: string, text: string) => void | Promise<void>;
  /** C.1: the same composer's draft, delivered as a brief amendment (`POST /amend`)
   *  rather than a plain inbox message. */
  onAmendLane: (id: string, text: string) => void | Promise<void>;
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
  const overCap = lane.tokenCap !== null && lane.tokens > lane.tokenCap && lane.state === 'running';
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

/** H2.4: the run's own story -- one dated sentence per entry, with a link when the
 *  entry names one (a PR, a ticket, a change). Rendered before the journal panel. */
function StoryPanel({ story }: { story: LaneStory | null }): JSX.Element | null {
  const [briefOpen, setBriefOpen] = useState(false);
  if (!story || (story.entries.length === 0 && !story.brief)) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      {story.entries.length > 0 ? (
        <>
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 10 }}>Story</div>
          <div className="m" style={{ fontSize: 11, lineHeight: 2, color: 'var(--ink2)' }}>
            {story.entries.map((entry, i) => (
              <div key={i}>
                <span style={{ color: 'var(--ink3)', fontWeight: 600 }}>{hm(entry.at)}</span>{' '}
                {entry.url ? (
                  <a href={entry.url} style={{ color: 'var(--ink)' }}>{entry.text}</a>
                ) : (
                  <span>{entry.text}</span>
                )}
              </div>
            ))}
          </div>
        </>
      ) : null}
      {story.brief ? (
        <div style={{ marginTop: 10 }}>
          <span className="lbl" style={{ color: 'var(--ink2)', cursor: 'pointer' }} onClick={() => setBriefOpen((v) => !v)}>brief</span>
          {briefOpen ? <div className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', marginTop: 6 }}>{story.brief.excerpt}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 2026-09-07: the ticket sheet's top summary block -- what was done, the lane's own
 *  status, whether it was audited, and whether it is proven ready to merge, with the
 *  Re-check and Re-audit buttons right there rather than making an operator dig for
 *  either fact somewhere else on the sheet. Renders nothing (rather than a loading
 *  placeholder) until the first fetch lands, matching `StoryPanel`'s own convention. */
function SummaryPanel({
  summary, loadFailed, onRecheck, onReaudit, reauditRunning, auditRef, highlightAudit,
}: {
  summary: LaneSummary | null;
  loadFailed?: boolean;
  onRecheck: () => void;
  onReaudit: () => void;
  reauditRunning: boolean;
  auditRef?: RefObject<HTMLDivElement | null>;
  highlightAudit?: boolean;
}): JSX.Element | null {
  if (loadFailed) {
    return (
      <div data-testid="ticket-sheet-summary" style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
        <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 10 }}>Summary</div>
        <div className="m" style={{ fontSize: '11.5px', color: 'var(--block)' }}>could not load the summary.</div>
      </div>
    );
  }
  if (!summary) return null;
  const { audit, readiness } = summary;
  const auditLine = audit
    ? `Council ${audit.verdict}, ${audit.reviewed} of ${audit.total} reviewed, `
      + `${audit.findings} ${audit.findings === 1 ? 'finding' : 'findings'}, at ${hm(audit.at)} on ${audit.head.slice(0, 7)}`
      + (audit.stale ? ` -- stale: ${audit.staleWhy}` : '')
    : 'Not audited.';
  const driftNote = readiness && (readiness.headMoved || (readiness.behindBase ?? 0) > 0)
    ? [
      readiness.headMoved ? 'head moved since the audit' : null,
      readiness.behindBase ? `base gained ${readiness.behindBase} commit${readiness.behindBase === 1 ? '' : 's'} since` : null,
    ].filter(Boolean).join('; ')
    : null;

  return (
    <div data-testid="ticket-sheet-summary" style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
      <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 10 }}>Summary</div>
      {summary.what.length > 0 ? (
        <ul className="m" style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: '11.5px', color: 'var(--ink)', lineHeight: 1.6 }}>
          {summary.what.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      ) : (
        <div className="m" style={{ fontSize: '11.5px', color: 'var(--ink3)', marginBottom: 12 }}>Nothing on record yet.</div>
      )}
      <div className="m" style={{ fontSize: '11.5px', color: 'var(--ink2)', marginBottom: 6 }}>{summary.status}</div>
      <div
        ref={auditRef} data-testid="ticket-sheet-audit" className="m"
        style={{
          fontSize: '11.5px', color: 'var(--ink2)', marginBottom: 6,
          outline: highlightAudit ? '2px solid var(--hand)' : 'none', outlineOffset: 4,
          transition: 'outline-color .3s',
        }}
      >
        {auditLine}
        {audit && audit.findingsText.length > 0 ? (
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
            {audit.findingsText.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        ) : null}
      </div>
      <div data-testid="ticket-sheet-readiness" className="m" style={{ fontSize: '11.5px', marginBottom: 12 }}>
        {readiness?.ok ? (
          <span style={{ color: 'var(--run)', fontWeight: 700 }}>Ready to merge.</span>
        ) : (
          <span style={{ color: 'var(--block)' }}>Not ready: {readiness?.why ?? 'unknown'}.</span>
        )}
        {driftNote ? <span style={{ color: 'var(--ink3)' }}> {driftNote}.</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <span className="btnS" style={{ padding: '6px 10px', fontSize: '9.5px' }} onClick={onRecheck}>Re-check</span>
        <span
          className="btnS"
          style={{ padding: '6px 10px', fontSize: '9.5px', opacity: reauditRunning ? 0.5 : 1, cursor: reauditRunning ? 'default' : 'pointer' }}
          onClick={reauditRunning ? undefined : onReaudit}
        >
          {reauditRunning ? 'Re-auditing…' : 'Re-audit'}
        </span>
      </div>
    </div>
  );
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
  const { lane, feedLive, now, focus, onClose, onCommand, onOpenCost, onOpenSandbox, onSendLane, onAmendLane, onUndo, onOpenJournal } = props;
  const [thread, setThread] = useState<Message[]>([]);
  const [journal, setJournal] = useState<JournalNarrativeEntry[]>([]);
  const [story, setStory] = useState<LaneStory | null>(null);
  const [summary, setSummary] = useState<LaneSummary | null>(null);
  const [summaryLoadFailed, setSummaryLoadFailed] = useState(false);
  const [reauditRunning, setReauditRunning] = useState(false);
  const [draft, setDraft] = useState('');
  const [highlightAudit, setHighlightAudit] = useState(false);
  const reauditPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditRef = useRef<HTMLDivElement | null>(null);

  // Sweep #8: "View council" must land on the council content it promised, not just
  // the sheet in general. Fires once summary data actually exists to scroll to.
  useEffect(() => {
    if (focus !== 'audit' || !summary || !auditRef.current) return;
    auditRef.current.scrollIntoView({ block: 'center' });
    setHighlightAudit(true);
    const timer = setTimeout(() => setHighlightAudit(false), 2_500);
    return () => clearTimeout(timer);
  }, [focus, summary]);

  useEffect(() => {
    let active = true;
    api.getRunThread(lane.id).then((r) => { if (active) setThread(r.messages); }).catch(() => undefined);
    api.getRunJournal(lane.id).then((r) => { if (active) setJournal(r.entries); }).catch(() => undefined);
    api.getRunStory(lane.id).then((r) => { if (active) setStory(r); }).catch(() => undefined);
    setSummaryLoadFailed(false);
    api.getRunSummary(lane.id).then((r) => { if (active) setSummary(r); })
      .catch(() => { if (active) setSummaryLoadFailed(true); });
    setReauditRunning(false);
    return () => {
      active = false;
      if (reauditPollRef.current) clearTimeout(reauditPollRef.current);
    };
  }, [lane.id]);

  const handleRecheck = useCallback(() => {
    api.recheckRun(lane.id).then(setSummary).catch(() => undefined);
  }, [lane.id]);

  // Polls the summary until the audit's own head no longer trails the PR's current one
  // (`readiness.headMoved` false once a fresh attestation lands), so the button stays
  // disabled for exactly as long as the round actually takes rather than a guessed delay.
  const pollAfterReaudit = useCallback((id: string) => {
    api.getRunSummary(id).then((next) => {
      setSummary(next);
      if (next.audit && next.readiness && !next.readiness.headMoved) {
        setReauditRunning(false);
        return;
      }
      reauditPollRef.current = setTimeout(() => pollAfterReaudit(id), 3_000);
    }).catch(() => setReauditRunning(false));
  }, []);

  const handleReaudit = useCallback(() => {
    setReauditRunning(true);
    api.reauditRun(lane.id).then((result) => {
      if (!result.started) { setReauditRunning(false); return; }
      reauditPollRef.current = setTimeout(() => pollAfterReaudit(lane.id), 3_000);
    }).catch(() => setReauditRunning(false));
  }, [lane.id, pollAfterReaudit]);

  // A send lands on the run's own thread server-side, but the thread above was fetched
  // once on open and never polls -- without this, the message the operator just typed
  // would silently vanish from the sheet until it was closed and reopened.
  const sendAndRefetch = useCallback((text: string) => {
    Promise.resolve(onSendLane(lane.id, text))
      .then(() => api.getRunThread(lane.id))
      .then((r) => setThread(r.messages))
      .catch(() => undefined);
  }, [onSendLane, lane.id]);

  // C.1: same shape as sendAndRefetch, but through the amendment path, so a correction
  // typed into this composer shows up in the run's own thread the same way a send does.
  const amendAndRefetch = useCallback((text: string) => {
    Promise.resolve(onAmendLane(lane.id, text))
      .then(() => api.getRunThread(lane.id))
      .then((r) => setThread(r.messages))
      .catch(() => undefined);
  }, [onAmendLane, lane.id]);

  const headline = laneHeadline(lane);
  const cta = laneCta(lane);
  const pct = ctxPercent(lane);
  const fresh = computeFreshness(lane.verifiedAt, lane.observedAt, feedLive, now);
  const canPause = (lane.state === 'running' || lane.state === 'handed-off') && !lane.runaway;
  // `blocked` included: it is otherwise the one lane state whose own CTA ("Gate log ->")
  // just reopens this same sheet, which reads as a genuine dead end for a lane blocked
  // by a stuck-session signal or a stale park record rather than an integration outage.
  // `exhausted` for the same reason: its own call to action, "Compact + resume", answers
  // an honest 501 because the runner cannot hand a run off on demand, which would leave an
  // exhausted run with no action at all. A run the operator can see must always be one the
  // operator can end.
  const canKill = (
    lane.state === 'running' || lane.state === 'handed-off' || lane.state === 'paused'
    || lane.state === 'blocked' || lane.state === 'exhausted'
  ) && !lane.runaway;
  const band = bandFor(lane);

  return (
    <div
      className="plate" data-testid="ticket-sheet"
      // The sheet is the screen's height less the overlay's margins and scrolls inside:
      // a long story or run thread used to push the band and the composer off the top
      // and bottom of the window (2026-09-07).
      style={{ width: 900, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 68px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderColor: 'var(--line2)' }}
    >
      <div className="lbl" style={{ background: band.bg, color: band.ink, padding: '7px 20px', display: 'flex', justifyContent: 'space-between', gap: 12, borderRadius: '3px 3px 0 0' }}>
        <span>{band.text}</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose}>esc to close ✕</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, whiteSpace: 'nowrap' }}>
          <span className="m" title={headline.runId} style={{ fontSize: 22, fontWeight: 700 }}>{headline.main}</span>
          {lane.title ? <span className="m" style={{ fontSize: 14, color: 'var(--ink2)' }}>{lane.title}</span> : null}
          <span className="chip">{kindLabel(lane.kind)}</span>
          {lane.sourceUrl ? <a className="m" href={lane.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: '10.5px' }}>source ↗</a> : null}
          <span className="chip">{lane.model}</span>
          <span className="chip">{lane.repo}</span>
          <span className="chip">attempt {lane.attempt}</span>
          <a className="m" style={{ fontSize: '10.5px' }} onClick={() => onOpenSandbox(lane.id)}>{lane.sandbox?.id ?? '--'}</a>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'right' }}>
            <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 3 }}>tokens</div>
            <span className={costClass(lane)} onClick={() => onOpenCost(lane.id)}>{fmtTokens(lane.tokens)}</span>
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
      {lane.pr && lane.mergeable && lane.mergeable.ok === false ? (
        <div className="m" style={{ padding: '8px 22px 0', fontSize: '10.5px', color: 'var(--ink3)' }}>
          Why not merged: {lane.mergeable.why}
        </div>
      ) : null}
      <SummaryPanel
        summary={summary} loadFailed={summaryLoadFailed} onRecheck={handleRecheck} onReaudit={handleReaudit} reauditRunning={reauditRunning}
        auditRef={auditRef} highlightAudit={highlightAudit}
      />
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
      <div data-testid="ticket-sheet-body" style={{ display: 'flex', minHeight: 0, flex: '1 1 auto', flexWrap: 'wrap', overflowY: 'auto' }}>
        <div data-testid="ticket-sheet-story" style={{ width: 340, flex: '1 1 300px', borderRight: '1px solid var(--line)', padding: '16px 22px' }}>
          <StoryPanel story={story} />
          <div className="lbl" style={{ color: 'var(--ink2)', marginBottom: 10 }}>Journal</div>
          <JournalPanel entries={journal} />
          {lane.pr ? (
            <>
              <div className="lbl" style={{ color: 'var(--ink2)', margin: '16px 0 8px' }}>Draft output</div>
              <div className="plate" style={{ padding: '10px 12px' }}>
                <a
                  className="m" style={{ fontSize: '11.5px', fontWeight: 700 }}
                  href={lane.pr.url} target="_blank" rel="noopener noreferrer"
                >
                  draft PR #{lane.pr.no} ↗
                </a>
                <div className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', marginTop: 4 }}>
                  {lane.pr.files} files · <span style={{ color: 'var(--run)', fontWeight: 700 }}>+{lane.pr.add}</span> <span style={{ color: 'var(--block)', fontWeight: 700 }}>−{lane.pr.del}</span>
                </div>
              </div>
            </>
          ) : null}
        </div>
        <div style={{ flex: '2 1 380px', padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="lbl" style={{ color: 'var(--ink2)', flex: 'none' }}>Run thread — {lane.id} only</div>
          <div data-testid="ticket-sheet-thread" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {thread.map((m) => (
              <MessageCard
                key={m.k} message={m} feedLive={feedLive} now={now}
                onCommand={(text) => onCommand(lane.id, text)} onUndo={onUndo}
                onOpenJournal={onOpenJournal}
              />
            ))}
          </div>
          <div style={{ marginTop: 'auto', background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '8px 8px 8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className="inp" placeholder={`message ${lane.id}…`} value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { sendAndRefetch(draft); setDraft(''); } }}
            />
            <span className="btnP" style={{ padding: '5px 10px', fontSize: '9.5px' }} onClick={() => { if (draft.trim()) { sendAndRefetch(draft); setDraft(''); } }}>Send ⏎</span>
            <span className="btnS" style={{ padding: '5px 10px', fontSize: '9.5px' }} onClick={() => { if (draft.trim()) { amendAndRefetch(draft); setDraft(''); } }}>Amend</span>
          </div>
        </div>
      </div>
    </div>
  );
}
