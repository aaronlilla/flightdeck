import type { JSX } from 'react';

import type { Lane } from '../../shared/console-model.js';
import type { Filter, Sort, TipSpec } from '../store.js';
import { LaneGroupTile } from './LaneGroupTile.js';
import { groupLanesByTicket } from '../laneVM.js';

const FINISHED_STATES = new Set(['done', 'merged', 'killed']);

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

export function LanesGrid(props: LanesGridProps): JSX.Element {
  const { lanes, filter, sort, feedLive, now, showProbes, onOpen, onOpenCost, onCommand, onTip } = props;
  const shown = visibleLanes(lanes, filter, sort, now, showProbes);
  const groups = groupLanesByTicket(shown);
  return (
    <div
      className="scroll"
      style={{
        flex: 1, padding: '12px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(215px,1fr))',
        gridAutoRows: 'auto', alignItems: 'stretch', gap: 10, alignContent: 'start',
      }}
    >
      {groups.map((group) => (
        <LaneGroupTile key={group.key} group={group} feedLive={feedLive} now={now} onOpen={onOpen} onOpenCost={onOpenCost} onCommand={onCommand} onTip={onTip} />
      ))}
      {groups.length === 0 ? (
        <div className="m" style={{ fontSize: 12, color: 'var(--ink3)', padding: 40, gridColumn: '1/-1', textAlign: 'center' }}>
          no lanes match this filter
        </div>
      ) : null}
    </div>
  );
}
