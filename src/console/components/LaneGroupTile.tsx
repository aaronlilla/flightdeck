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

/** One grid cell per ticket, so every cell in a row stays the same height. Renders
 *  the newest attempt in a group of retries; the Board card (design 2/3) dropped the
 *  attempt-count chip and the earlier-attempts disclosure that used to live here,
 *  along with the rest of the old tile's chip row -- the ticket sheet still has the
 *  full attempt history for a lane that needs it. */
export function LaneGroupTile({ group, feedLive, now, onOpen, onOpenCost, onCommand, onTip }: LaneGroupTileProps): JSX.Element {
  // The newest attempt is whichever lane in the group actually started last, never
  // `Lane.attempt` -- that field is the server's reopen counter and can run far ahead
  // of how many attempts are actually on the board.
  const newest = [...group.lanes].sort((a, b) => a.startedAt - b.startedAt).at(-1) as Lane;
  return (
    <LaneTile
      lane={newest} feedLive={feedLive} now={now} onOpen={onOpen} onOpenCost={onOpenCost} onCommand={onCommand} onTip={onTip}
    />
  );
}
