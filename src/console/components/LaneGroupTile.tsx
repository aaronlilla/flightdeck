import type { JSX } from 'react';

import type { LaneGroup } from '../laneVM.js';
import type { TipSpec } from '../store.js';
import type { Lane } from '../../shared/console-model.js';
import { LaneTile } from './LaneTile.js';

export interface LaneGroupTileProps {
  group: LaneGroup;
  feedLive: boolean;
  now: number;
  onOpen: (id: string) => void;
  onOpenCost: (id: string) => void;
  onCommand: (id: string, cmd: string) => void;
  onTip: (tip: TipSpec | null) => void;
}

/** H2.2: one grid cell per ticket, so every cell in a row stays the same height
 *  (2026-09-08). A single-attempt group renders the plain tile; a group with more
 *  than one attempt gives `LaneTile` an "attempt N of M" chip on its own chip row
 *  and the earlier attempts to open a disclosure over, inside the tile, above the
 *  footer -- never a second box hanging below it. */
export function LaneGroupTile({ group, feedLive, now, onOpen, onOpenCost, onCommand, onTip }: LaneGroupTileProps): JSX.Element {
  // H2.2 fix: the position shown (and the split between "newest" and "the others")
  // comes from sorting the group's own lanes by when they actually started, never
  // from `Lane.attempt` -- that field is the server's reopen counter and can run far
  // ahead of how many attempts are actually on the board (a lane reopened 25 times in
  // a group of 4 must still read "attempt 4 of 4"). Oldest first, so the newest lane
  // -- the one the tile renders -- is last, and the disclosure lists the rest oldest
  // first with no further reordering.
  const byStartedAt = [...group.lanes].sort((a, b) => a.startedAt - b.startedAt);
  const [earlier, newest] = [byStartedAt.slice(0, -1), byStartedAt[byStartedAt.length - 1] as Lane];
  const position = byStartedAt.length;
  return (
    <LaneTile
      lane={newest} feedLive={feedLive} now={now} onOpen={onOpen} onOpenCost={onOpenCost} onCommand={onCommand} onTip={onTip}
      attempts={earlier.length > 0 ? { position, total: group.lanes.length } : undefined}
      earlier={earlier.length > 0 ? earlier : undefined}
    />
  );
}
