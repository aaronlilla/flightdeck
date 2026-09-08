import type { JSX, MouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { actionable } from '../keyboard-actionable.js';
import {
  costClass, costTip, ctxPercent, ctxTip, kindLabel, laneCta, mergeableWhy, modelTip, plainLine, prSummaryParts,
  stateOf, tileCapText, tileHeadlineParts,
} from '../laneVM.js';
import type { TipContent } from '../laneVM.js';
import { computeFreshness, freshnessClass, freshnessStamp } from '../freshness.js';
import type { Lane } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import type { TipSpec } from '../store.js';

const HOVER_DELAY_MS = 250;

export interface LaneTileProps {
  lane: Lane;
  feedLive: boolean;
  now: number;
  onOpen: (id: string) => void;
  onOpenCost: (id: string) => void;
  onCommand: (id: string, cmd: string) => void;
  onTip: (tip: TipSpec | null) => void;
  /** 2026-09-08: set only for the newest lane in a retried ticket's group. Renders
   *  the "attempt N of M" chip on the chip row (instead of a second box hanging
   *  below the tile) and, together with `earlier`, the disclosure that lists the
   *  earlier attempts inside the tile, above the footer. */
  attempts?: { position: number; total: number };
  /** The group's earlier attempts, oldest first -- rendered inside the disclosure
   *  `attempts` opens. Ignored when `attempts` is unset. */
  earlier?: Lane[];
}

/** One board tile: id, model chip, state, step, context gauge, cost readout, freshness, one CTA. */
export function LaneTile({ lane, feedLive, now, onOpen, onOpenCost, onCommand, onTip, attempts, earlier }: LaneTileProps): JSX.Element {
  const st = stateOf(lane.state);
  const [attemptsOpen, setAttemptsOpen] = useState(false);
  const headline = tileHeadlineParts(lane);
  const cta = laneCta(lane);
  const why = mergeableWhy(lane);
  const pct = ctxPercent(lane);
  const fresh = computeFreshness(lane.verifiedAt, lane.observedAt, feedLive, now, lane.heart);
  const opacity = fresh.verified ? 1 : 0.6;

  // Keyed rather than a single flag: a stray enter/leave pair from an adjacent
  // hover target (context gauge, model chip, cost readout) must never cancel or
  // overwrite a still-current hover for a different one.
  const hover = useRef<{ timer: ReturnType<typeof setTimeout> | null; key: string | null }>({ timer: null, key: null });
  useEffect(() => () => { if (hover.current.timer) clearTimeout(hover.current.timer); }, []);
  const showTip = (key: string, e: MouseEvent, tip: TipContent): void => {
    const x = e.clientX + 12;
    const y = e.clientY + 12;
    if (hover.current.timer) clearTimeout(hover.current.timer);
    hover.current.key = key;
    hover.current.timer = setTimeout(() => {
      if (hover.current.key === key) onTip({ x, y, head: tip.head, body: tip.body, click: tip.click, color: tip.color });
    }, HOVER_DELAY_MS);
  };
  const hideTip = (key: string): void => {
    if (hover.current.key !== key) return;
    if (hover.current.timer) clearTimeout(hover.current.timer);
    hover.current.timer = null;
    hover.current.key = null;
    onTip(null);
  };

  return (
    <div
      className="lane"
      data-testid={`lane-${lane.id}`}
      data-state={lane.state}
      style={{ borderColor: lane.state === 'parked' ? 'var(--park)' : undefined, opacity, height: '100%' }}
      {...actionable(() => onOpen(lane.id))}
    >
      {lane.state === 'parked' ? (
        <div
          className="lbl"
          style={{ margin: '-12px -13px 2px', background: 'var(--park)', color: 'var(--aInk)', padding: '5px 13px', display: 'flex', justifyContent: 'space-between', borderRadius: '3px 3px 0 0' }}
        >
          <span>◆ human needed</span>
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
          <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {headline.key ? (
              <span className="m" title={headline.runId} style={{ fontSize: 13, fontWeight: 700 }}>{headline.key}</span>
            ) : (
              <span className="m" title={headline.runId} style={{ fontSize: 13, fontWeight: 700 }}>{headline.title ?? headline.runId}</span>
            )}
          </div>
          <span style={{ display: 'flex', gap: 4, flex: 'none', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className="chip" style={{ fontSize: 9 }}>{kindLabel(lane.kind)}</span>
            <span
              className="chip"
              onMouseEnter={(e) => showTip('model', e, modelTip(lane, fresh))}
              onMouseLeave={() => hideTip('model')}
            >
              {lane.model}
            </span>
            {attempts ? (
              <span
                className="chip chipB"
                {...actionable((e) => { e?.stopPropagation?.(); setAttemptsOpen((v) => !v); })}
              >
                attempt {attempts.position} of {attempts.total}
              </span>
            ) : null}
          </span>
        </div>
        {headline.key && headline.title ? (
          <div
            className="m"
            title={headline.title}
            style={{
              fontSize: 12, color: 'var(--ink2)', display: '-webkit-box',
              WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}
          >
            {headline.title}
          </div>
        ) : null}
      </div>
      <div className="lbl" style={{ color: st.color, cursor: 'help' }}>{st.glyph} {st.label}</div>
      <div
        title={plainLine(lane)}
        style={{
          font: '12.5px/1.45 "IBM Plex Sans",sans-serif', color: 'var(--ink2)', minHeight: 38,
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          overflowWrap: 'anywhere',
        }}
      >
        {plainLine(lane)}
      </div>
      <div style={{ cursor: 'help' }} onMouseEnter={(e) => showTip('ctx', e, ctxTip(lane, fresh))} onMouseLeave={() => hideTip('ctx')}>
        <div style={{ position: 'relative', height: 8, background: 'var(--well)', borderRadius: 2, boxShadow: 'inset 0 1px 3px rgba(0,0,0,.6)', borderRight: '3px solid var(--block)' }}>
          <div style={{ position: 'absolute', top: 1, bottom: 1, left: 1, width: `${pct}%`, background: `repeating-linear-gradient(90deg, ${st.color} 0 5px, transparent 5px 7px)` }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, whiteSpace: 'nowrap' }}>
          <span className="m" style={{ fontSize: '9.5px', color: 'var(--ink2)' }}>context {pct}%</span>
          <span className="m" style={{ fontSize: '9.5px', color: 'var(--ink3)' }}>ceiling {Math.round(lane.ctxCeiling / 1000)}k</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span
          className={costClass(lane, !fresh.verified)}
          {...actionable((e) => { e?.stopPropagation?.(); onOpenCost(lane.id); })}
          onMouseEnter={(e) => showTip('cost', e, costTip(lane, fresh))}
          onMouseLeave={() => hideTip('cost')}
        >
          {fmtTokens(lane.tokens)}
        </span>
        <span className="m" style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--block)', whiteSpace: 'nowrap' }}>
          {tileCapText(lane)}
        </span>
      </div>
      {lane.pr ? (
        <div className="m" title={`PR #${prSummaryParts(lane.pr).no} · ${prSummaryParts(lane.pr).rest}`} style={{ fontSize: '10.5px', color: 'var(--ink2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <a
            href={lane.pr.url} target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()} style={{ fontWeight: 700, color: 'var(--ink)' }}
          >
            PR #{prSummaryParts(lane.pr).no}
          </a>
          {' · '}{prSummaryParts(lane.pr).rest}
        </div>
      ) : null}
      {attempts && earlier && earlier.length > 0 && attemptsOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--well)', borderRadius: 3, padding: '8px 10px' }}>
          {earlier.map((l) => {
            const earlierCta = laneCta(l);
            return (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)' }}>{plainLine(l)}</span>
                <span
                  className={earlierCta.cls}
                  style={{ padding: '5px 8px', fontSize: 9, flex: 'none' }}
                  {...actionable((e) => { e?.stopPropagation?.(); onCommand(l.id, earlierCta.cmd); })}
                >
                  {earlierCta.label}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--line)', paddingTop: 7, marginTop: 'auto' }}>
        <span className={freshnessClass(fresh)} style={{ alignSelf: 'flex-start' }}>{freshnessStamp(fresh)}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <span
            className={cta.cls}
            style={{ padding: '7px 9px', fontSize: '9.5px', flex: 1 }}
            {...actionable((e) => { e?.stopPropagation?.(); onCommand(lane.id, cta.cmd); })}
          >
            {cta.label}
          </span>
        </div>
        {why ? <span className="m" style={{ fontSize: '9.5px', color: 'var(--ink3)' }}>{why}</span> : null}
      </div>
    </div>
  );
}
