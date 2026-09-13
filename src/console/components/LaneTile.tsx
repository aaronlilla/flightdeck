import type { JSX } from 'react';

import { boardCta, boardStateWord, timeInStateText, tileHeadlineParts, type BoardCommand } from '../laneVM.js';
import { laneActionLiveness } from '../actionLiveness.js';
import { actionable } from '../../shared/liveness.js';
import { WhatIsHover } from './WhatIsCard.js';
import type { Blocker, Lane } from '../../shared/console-model.js';
import { Marks } from './QuestionCard.js';

/**
 * One card of the Board's running grid (`FD Board.dc.html`, the `lanes` loop): key, the
 * state word, the title, one sentence on what it is doing, how long it has been in that
 * state, and the one button its state earns. The run id never renders; a lane with no
 * ticket shows what kind of run it is where the key would go.
 */
export interface LaneTileProps {
  lane: Lane;
  now: number;
  /** The open blocker this lane waits on, when the Blockers view knows one. It decides
   *  the button on a blocked card and the "who" on the blocked rows. */
  blocker?: Blocker | null;
  onOpen: (id: string) => void;
  onCommand: (id: string, cmd: BoardCommand) => void;
  /** Kept for callers written against the earlier card; the design's card has no cost
   *  readout, hover card or live-feed treatment, so these are accepted and unused. */
  feedLive?: boolean;
  onOpenCost?: (id: string) => void;
  onTip?: (tip: unknown) => void;
}

export function LaneTile({ lane, now, blocker = null, onOpen, onCommand }: LaneTileProps): JSX.Element {
  const word = boardStateWord(lane);
  const cta = boardCta(lane, blocker);
  const action = actionable(cta, laneActionLiveness({ lane, cmd: cta.cmd }));
  const head = tileHeadlineParts(lane);
  // No title and a ticket key means the key is all there is, and it is already in the
  // kicker above -- printing it again gave the tile "BBZ-123" over "BBZ-123", which
  // fills the most prominent line on the card with something already on screen. The
  // line is dropped instead, and the tile's own status line moves up into it.
  const title = head.title?.trim() || (head.key ? null : 'Untitled run');
  // The kicker slot holds the ticket. A lane without one used to fill it with the lane's
  // own kind -- "manual run", "brief run" -- which names an internal category and tells
  // a person nothing they can act on. Aaron, 2026-09-12: every board item should be a
  // ticket being worked on. Saying so out loud makes the untracked ones visible as
  // untracked instead of dressing them up as a category.
  const keyText = head.key ?? 'No ticket';
  return (
    <div
      data-testid={`lane-${lane.id}`}
      style={{
        position: 'relative', minWidth: 0, border: `1px solid ${word.border}`, borderStyle: word.borderStyle, padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 5, minHeight: 112, background: word.background, cursor: 'pointer',
      }}
      onClick={() => onOpen(lane.id)}
    >
      <Marks />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        {/* The ticket key is what a reader hovers to ask what this is (Aaron,
            2026-09-12). It is a plain span rather than a link here, so the hover is
            attached directly; `No ticket` names nothing and gets none. */}
        {head.key ? (
          <WhatIsHover refText={head.key}>
            <span className="key" data-testid="tile-key" title={keyText} style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{keyText}</span>
          </WhatIsHover>
        ) : (
          <span className="key" data-testid="tile-key" title={keyText} style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{keyText}</span>
        )}
        <span data-testid="tile-state" style={{ flex: 'none', fontSize: 'var(--fs-kicker)', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: word.color }}>{word.word}</span>
      </div>
      {title === null ? null : (
        <div className="hd" data-testid="tile-title" dir="auto" title={title} style={{ fontSize: 'var(--fs-rowhead)', lineHeight: 1.1, flex: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
      )}
      <p data-testid="tile-now" style={{ margin: 0, flex: 'none', color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.now || lane.plain || lane.stepText}</p>
      <div data-testid="tile-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginRight: 8 }}>
          {timeInStateText(lane, now, word.word)}{lane.attempts > 1 ? ` · attempt ${lane.attempt} of ${lane.attempts}` : ''}
        </span>
        {/* The verdict decides whether this is a button at all. A tile offering Merge on
            a pull request that merged an hour ago is not a broken button, it is the board
            telling somebody to do a thing already done (Aaron, 2026-09-12). A dead action
            renders as the reason instead, so the tile still says where it stands. */}
        {action.liveness.live ? (
          <button
            type="button" className={`btn ${cta.kind}`} data-testid="primary-action" data-cmd={cta.cmd}
            onClick={(e) => { e.stopPropagation(); onCommand(lane.id, cta.cmd); }}
          >
            {cta.label}
          </button>
        ) : (
          <span
            data-testid="primary-action-unavailable" data-cmd={cta.cmd}
            title={action.liveness.why}
            style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}
          >
            {action.liveness.why}
          </span>
        )}
      </div>
    </div>
  );
}
