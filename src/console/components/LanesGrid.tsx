import type { JSX } from 'react';

import type { Lane } from '../../shared/console-model.js';
import type { Filter, Sort, TipSpec } from '../store.js';
import { LaneGroupTile } from './LaneGroupTile.js';
import { CARD_GAP_PX } from '../grid.js';
import { groupLanesByTicket } from '../laneVM.js';

const FINISHED_STATES = new Set(['done', 'merged', 'killed']);

/** The Board's own two-column, eight-card grid (design 2/3, `doctrine/design/FD
 *  Board.dc.html`) -- fixed at two columns, unlike the queue's `BOARD_GRID_COLUMNS`,
 *  which still auto-fills up to four. */
const BOARD_COLUMNS = 2;
const BOARD_SLOTS = 8;

function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** H2.2: `archived` reads the caller's own already-fetched archived set (retired
 *  lanes), never the live board; every other filter hides a `probe` lane unless
 *  `showProbes` is on, so ALL/NEEDS ME/RUNNING/FINISHED count exactly what a probe
 *  toggle-off board actually shows. */
export function visibleLanes(lanes: Lane[], filter: Filter, sort: Sort, now: number = Date.now(), showProbes = false): Lane[] {
  let filtered: Lane[];
  if (filter === 'archived') {
    filtered = lanes.filter((l) => l.retiredAt !== null);
  } else {
    const withoutProbes = showProbes ? lanes : lanes.filter((l) => l.kind !== 'probe');
    if (filter === 'needs-me') {
      filtered = withoutProbes.filter((l) => l.state === 'parked' || l.state === 'blocked' || (l.state === 'running' && l.runaway));
    } else if (filter === 'running') {
      filtered = withoutProbes.filter((l) => l.state === 'running' || l.state === 'handed-off');
    } else if (filter === 'finished') {
      filtered = withoutProbes.filter((l) => FINISHED_STATES.has(l.state));
    } else if (filter !== 'all') {
      filtered = withoutProbes.filter((l) => l.repo === filter);
    } else {
      filtered = withoutProbes;
    }
  }
  const sorted = [...filtered];
  if (sort === 'cost') sorted.sort((a, b) => b.tokens - a.tokens);
  else if (sort === 'age') sorted.sort((a, b) => a.startedAt - b.startedAt);
  else sorted.sort((a, b) => a.state.localeCompare(b.state));
  return sorted;
}

export interface LanesGridProps {
  lanes: Lane[];
  filter: Filter;
  sort: Sort;
  feedLive: boolean;
  now: number;
  showProbes: boolean;
  onOpen: (id: string) => void;
  onOpenCost: (id: string) => void;
  onCommand: (id: string, cmd: string) => void;
  onTip: (tip: TipSpec | null) => void;
}

/** An empty Board slot (design 2/3): a dashed-border placeholder card that names what
 *  it is waiting for, filled in whenever fewer than `BOARD_SLOTS` lanes are running. */
function IdleSlot({ index }: { index: number }): JSX.Element {
  return (
    <div
      data-testid={`idle-slot-${index}`}
      style={{
        border: '1px dashed var(--ink3)', borderRadius: 8, padding: 16, minHeight: 120,
        display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      }}
    >
      <span className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>Waiting for a Ready ticket</span>
    </div>
  );
}

export function LanesGrid(props: LanesGridProps): JSX.Element {
  const { lanes, filter, sort, feedLive, now, showProbes, onOpen, onOpenCost, onCommand, onTip } = props;
  const shown = visibleLanes(lanes, filter, sort, now, showProbes);
  const groups = groupLanesByTicket(shown);
  const idleCount = Math.max(0, BOARD_SLOTS - groups.length);
  return (
    <div
      className="scroll"
      style={{
        flex: 1, padding: '12px 16px 16px', display: 'grid', gridTemplateColumns: `repeat(${BOARD_COLUMNS}, 1fr)`,
        // 2026-09-08: `1fr` rows plus a tile that stretched to `height: 100%` is what
        // made the taller cards overlap on the live board -- `auto` rows sized to each
        // tile's own (now fixed-slot) content, with `alignItems: 'start'` so no tile
        // stretches to fill a row it does not need.
        gridAutoRows: 'auto', alignItems: 'start', gap: CARD_GAP_PX, alignContent: 'start',
      }}
    >
      {groups.map((group) => (
        <LaneGroupTile key={group.key} group={group} feedLive={feedLive} now={now} onOpen={onOpen} onOpenCost={onOpenCost} onCommand={onCommand} onTip={onTip} />
      ))}
      {Array.from({ length: idleCount }, (_, i) => <IdleSlot key={`idle-${i}`} index={i} />)}
    </div>
  );
}
