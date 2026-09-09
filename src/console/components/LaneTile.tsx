import type { JSX } from 'react';

import { LaneCta } from './LaneCta.js';

import { actionable } from '../keyboard-actionable.js';
import { boardStateWord, laneCta, plainLine, tileHeadlineParts, timeInStateText } from '../laneVM.js';
import type { TipSpec } from '../store.js';
import type { Lane } from '../../shared/console-model.js';
import { Linkify } from './Linkify.js';

export interface LaneTileProps {
  lane: Lane;
  feedLive: boolean;
  now: number;
  onOpen: (id: string) => void;
  onOpenCost: (id: string) => void;
  onCommand: (id: string, cmd: string) => void;
  onTip: (tip: TipSpec | null) => void;
}

/** The four corner marks from the design's blueprint styling (`FD Board.dc.html`).
 *  Decorative only. */
function CornerMarks(): JSX.Element {
  const mark = { position: 'absolute' as const, width: 11, height: 11, background: 'var(--mk)' };
  return (
    <>
      <i aria-hidden="true" style={{ ...mark, top: -6, left: -6 }} />
      <i aria-hidden="true" style={{ ...mark, top: -6, right: -6 }} />
      <i aria-hidden="true" style={{ ...mark, bottom: -6, left: -6 }} />
      <i aria-hidden="true" style={{ ...mark, bottom: -6, right: -6 }} />
    </>
  );
}

/**
 * The Board card (design 2/3, `doctrine/design/FD Board.dc.html`): key and state
 * word, title, one sentence on what the lane is doing now, time in state, and exactly
 * one button. Everything the old tile carried beyond that, chips, the YOU block, the
 * context gauge, the cost readout, the PR summary, attempt disclosures, is gone. Click
 * the card and the ticket sheet still has all of it. `feedLive`, `onOpenCost` and
 * `onTip` stay in the prop list unused for now, because `LaneGroupTile` and
 * `LanesGrid` still pass them through; drop them from the list once nothing upstream
 * needs the wider contract.
 */
export function LaneTile({ lane, now, onOpen, onCommand }: LaneTileProps): JSX.Element {
  const headline = tileHeadlineParts(lane);
  const cta = laneCta(lane);
  const word = boardStateWord(lane);
  // H2.1 (fixed 2026-09-09): a manual lane with no ticket and no title used to show
  // its own raw run id as the title, the one machine string the rest of the board was
  // built to hide. No fallback now: a lane with neither shows nothing here.
  const titleText = lane.title;
  const nowSentence = lane.you ?? plainLine(lane);

  return (
    <div
      className="lane"
      data-testid={`lane-${lane.id}`}
      data-state={lane.state}
      data-run-id={lane.id}
      style={{ position: 'relative', boxSizing: 'border-box' }}
      {...actionable(() => onOpen(lane.id))}
    >
      <CornerMarks />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        {headline.key ? (
          <span className="m" style={{ fontSize: 'var(--fs-title)', fontWeight: 700 }}><Linkify text={headline.key} repo={lane.repo ?? undefined} /></span>
        ) : <span />}
        <span className="lbl" style={{ color: word.color }}>{word.word}</span>
      </div>
      {titleText ? (
        <div className="m" style={{ fontSize: 'var(--fs-title)', fontWeight: 400, color: 'var(--ink)', overflowWrap: 'anywhere' }}>
          <Linkify text={titleText} repo={lane.repo ?? undefined} />
        </div>
      ) : null}
      <div style={{ fontSize: 'var(--fs-body)', lineHeight: 1.4, color: 'var(--ink2)' }}>
        <Linkify text={nowSentence} repo={lane.repo ?? undefined} />
      </div>
      <div className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{timeInStateText(lane, now, word.word)}</div>
      <div data-testid="tile-footer" style={{ display: 'flex', gap: 6 }}>
        <span data-testid="primary-action" style={{ flex: 1, display: 'flex' }}>
          <LaneCta
            lane={lane} cmd={cta.cmd} label={cta.label} cls={cta.cls}
            style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', flex: 1, height: 36, boxSizing: 'border-box' }}
            onCommand={onCommand} stopPropagation
          />
        </span>
      </div>
    </div>
  );
}
