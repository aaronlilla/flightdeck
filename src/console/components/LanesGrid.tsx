import type { JSX } from 'react';

import type { Lane } from '../../shared/console-model.js';
import type { Filter, Sort, TipSpec } from '../store.js';
import { LaneTile } from './LaneTile.js';

export function visibleLanes(lanes: Lane[], filter: Filter, sort: Sort): Lane[] {
  let filtered = lanes;
  if (filter === 'needs-me') {
    filtered = lanes.filter((l) => l.state === 'parked' || l.state === 'blocked' || (l.state === 'running' && l.runaway));
  } else if (filter === 'running') {
    filtered = lanes.filter((l) => l.state === 'running' || l.state === 'handed-off');
  } else if (filter === 'finished') {
    filtered = lanes.filter((l) => l.state === 'done' || l.state === 'merged' || l.state === 'killed');
  } else if (filter !== 'all') {
    filtered = lanes.filter((l) => l.repo === filter);
  }
  const sorted = [...filtered];
  if (sort === 'cost') sorted.sort((a, b) => b.costUsd - a.costUsd);
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
  onOpen: (id: string) => void;
  onOpenCost: (id: string) => void;
  onCommand: (id: string, cmd: string) => void;
  onTip: (tip: TipSpec | null) => void;
}

export function LanesGrid(props: LanesGridProps): JSX.Element {
  const { lanes, filter, sort, feedLive, now, onOpen, onOpenCost, onCommand, onTip } = props;
  const shown = visibleLanes(lanes, filter, sort);
  return (
    <div
      className="scroll"
      style={{ flex: 1, padding: '12px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(215px,1fr))', gap: 10, alignContent: 'start' }}
    >
      {shown.map((lane) => (
        <LaneTile key={lane.id} lane={lane} feedLive={feedLive} now={now} onOpen={onOpen} onOpenCost={onOpenCost} onCommand={onCommand} onTip={onTip} />
      ))}
      {shown.length === 0 ? (
        <div className="m" style={{ fontSize: 12, color: 'var(--ink3)', padding: 40, gridColumn: '1/-1', textAlign: 'center' }}>
          no lanes match this filter
        </div>
      ) : null}
    </div>
  );
}
