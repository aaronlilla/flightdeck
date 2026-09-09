import type { JSX } from 'react';

import type { LaneGroup, BoardCommand } from '../laneVM.js';
import type { Blocker } from '../../shared/console-model.js';
import { LaneTile } from './LaneTile.js';

/** Lanes sharing a ticket fold into one card: the newest attempt is the card, and its
 *  time line says which attempt this is. */
export interface LaneGroupTileProps {
  group: LaneGroup;
  now: number;
  blocker?: Blocker | null;
  onOpen: (id: string) => void;
  onCommand: (id: string, cmd: BoardCommand) => void;
  feedLive?: boolean;
  onOpenCost?: (id: string) => void;
  onTip?: (tip: unknown) => void;
}

export function LaneGroupTile({ group, now, blocker = null, onOpen, onCommand }: LaneGroupTileProps): JSX.Element {
  const newest = group.lanes[0]!;
  const lane = group.lanes.length > 1 ? { ...newest, attempts: group.lanes.length } : newest;
  return <LaneTile lane={lane} now={now} blocker={blocker} onOpen={onOpen} onCommand={onCommand} />;
}
