import type { JSX, MouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { actionable } from '../keyboard-actionable.js';
import {
  costClass, costTip, ctxPercent, ctxTip, kindLabel, laneCta, mergeableWhy, modelTip, prSummaryParts,
  stateOf, tileCapText, tileHeadlineParts,
} from '../laneVM.js';
import type { TipContent } from '../laneVM.js';
import { computeFreshness, freshnessClass, freshnessStamp } from '../freshness.js';
import type { Lane } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import { shortenShas } from '../../shared/humanize.js';
import type { TipSpec } from '../store.js';
import { Linkify } from './Linkify.js';

const HOVER_DELAY_MS = 250;

// 2026-09-08: every variable slot below the chip row keeps one of these two fixed
// pixel heights, reserved whether or not that slot has anything to show -- the same
// content (Did present or absent, a PR line or none) must produce the exact same
// total tile height, or tiles sharing a row stop matching and the ones after them
// overlap the row below.
const LINE_H = 16;
const YOU_BLOCK_H = 40;
// One height for the title's 2-line slot regardless of whether it renders at 12px
// (keyed) or 13px (keyless) -- a per-font-size height would make a keyed and a
// keyless tile disagree on height in the same row.
const TITLE_H = 36;

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

/**
 * One board tile (2026-09-08 rework, Aaron, off the live board): row 1 is the ticket
 * key and the state, nothing above it; the title runs the full width below; the chip
 * row sits below the title, never beside it; the YOU block is the most prominent thing
 * on the card; two quiet lines carry Did and Now; the context gauge, the tokens/PR
 * line and the footer are unchanged. Every variable slot below the chip row keeps a
 * fixed height, so every tile in a row lands at the same height with no overlap --
 * the grid (`LanesGrid.tsx`) reads `gridAutoRows: auto` rather than stretching a `1fr`
 * row over a tile whose own height varies.
 */
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

  // `shortenShas` at render time, the same as `plainLine` always did for `plain` --
  // a fixture (or an older server) can still hand this a raw 40-char sha.
  const didText = lane.did ? shortenShas(lane.did) : null;
  const nowText = shortenShas(lane.now);

  // Row 2: the title line. A lane with a title shows it, sized down (the key already
  // carries the weight in row 1); a lane with no title but a key shows the key again
  // here rather than leaving the line empty; a lane with neither renders nothing.
  const titleLineText = lane.title ?? headline.key ?? null;
  const titleFontSize = headline.key ? 12 : 13;
  const titleFontWeight = headline.key ? 400 : 700;

  return (
    <div
      className="lane"
      data-testid={`lane-${lane.id}`}
      data-state={lane.state}
      data-run-id={lane.id}
      style={{ borderColor: lane.state === 'parked' ? 'var(--park)' : undefined, opacity, boxSizing: 'border-box' }}
      {...actionable(() => onOpen(lane.id))}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6, height: 18 }}>
        {headline.key ? (
          <span className="m" style={{ fontSize: 13, fontWeight: 700 }}><Linkify text={headline.key} repo={lane.repo ?? undefined} /></span>
        ) : <span />}
        <span className="lbl" style={{ color: st.color, cursor: 'help', flex: 'none' }}>{st.glyph} {st.label}</span>
      </div>
      <div
        className="m"
        title={titleLineText ?? undefined}
        style={{
          fontSize: titleFontSize, fontWeight: titleFontWeight, color: 'var(--ink)', width: '100%',
          overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          // A hard `height` (not `minHeight`), the same for every tile regardless of
          // font size or whether there is any title text at all: not the line-clamp's
          // own webkit box establishing the size, and not left to vary by content --
          // a grid item with `gridAutoRows: auto` mis-measures a
          // `-webkit-box`/`-webkit-line-clamp` child's intrinsic size for track sizing
          // (Chromium, 2026-09-08), undershooting the track height and producing the
          // exact row-over-row overlap this rework exists to remove; a title slot
          // whose height depended on its own content produced the same overlap
          // whenever two tiles in a row disagreed on whether they had one.
          overflow: 'hidden', height: TITLE_H,
        }}
      >
        {titleLineText ? <Linkify text={titleLineText} repo={lane.repo ?? undefined} /> : null}
      </div>
      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
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
      {lane.you ? (
        <div className="youP" style={{ borderLeft: '3px solid var(--park)', padding: '7px 9px', height: YOU_BLOCK_H, boxSizing: 'border-box', overflow: 'hidden' }}>
          <div className="lbl" style={{ color: 'var(--park)' }}>YOU</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            <Linkify text={lane.you} repo={lane.repo ?? undefined} />
          </div>
        </div>
      ) : (
        <div style={{ height: YOU_BLOCK_H, display: 'flex', alignItems: 'center', boxSizing: 'border-box' }}>
          <span className="m" style={{ fontSize: 11, color: 'var(--ink3)' }}>Nothing needed from you.</span>
        </div>
      )}
      <div style={{ height: LINE_H, overflow: 'hidden' }}>
        {didText ? (
          <div
            title={didText}
            style={{
              font: '11.5px/1.3 "IBM Plex Sans",sans-serif', color: 'var(--ink2)', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            <span className="lbl" style={{ color: 'var(--ink3)' }}>Did </span>
            <Linkify text={didText} repo={lane.repo ?? undefined} />
          </div>
        ) : null}
      </div>
      <div
        title={nowText}
        style={{
          height: LINE_H, overflow: 'hidden',
          font: '11.5px/1.3 "IBM Plex Sans",sans-serif', color: 'var(--ink2)', whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        <span className="lbl" style={{ color: 'var(--ink3)' }}>Now </span>
        <Linkify text={nowText} repo={lane.repo ?? undefined} />
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
      <div style={{ height: LINE_H, overflow: 'hidden' }}>
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
      </div>
      {attempts && earlier && earlier.length > 0 && attemptsOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--well)', borderRadius: 3, padding: '8px 10px' }}>
          {earlier.map((l) => {
            const earlierCta = laneCta(l);
            return (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)' }}>{l.now}</span>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--line)', paddingTop: 7 }}>
        <span className={freshnessClass(fresh)} style={{ alignSelf: 'flex-start' }}>{freshnessStamp(fresh)}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <span
            className={cta.cls}
            // `.btnS` (2026-09-08: `Watch live`/`Gate log` etc.) carries a real 1px
            // border the other CTA classes render as a box-shadow ring instead --
            // a fixed height plus border-box keeps every CTA the same footer height
            // regardless of which button class a lane's own state picks.
            style={{ padding: '7px 9px', fontSize: '9.5px', flex: 1, height: 32, boxSizing: 'border-box' }}
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
