import type { JSX } from 'react';

import type { Lane } from '../../shared/console-model.js';
import { groupLanesByTicket } from '../laneVM.js';
import type { Filter, Sort } from '../store.js';
import { visibleLanes } from './LanesGrid.js';

export interface FiltersProps {
  filter: Filter;
  sort: Sort;
  /** The distinct repos across the lanes on the board, in first-seen order -- see
   *  `renderVals`'s `F` array (script_wrapped.txt 266). Not a fixed pair: a fleet
   *  whose lanes carry no `repo` at all renders no repo chip. */
  repos: string[];
  lanes: Lane[];
  archivedLanes: Lane[];
  showProbes: boolean;
  now: number;
  onFilter: (filter: Filter) => void;
  onSort: (sort: Sort) => void;
  onToggleProbes: () => void;
}

const BASE_FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'needs-me', label: 'needs me' },
  { key: 'running', label: 'running' },
  { key: 'finished', label: 'finished' },
];

const SORTS: { key: Sort; label: string }[] = [
  { key: 'cost', label: 'cost ↓' },
  { key: 'age', label: 'age' },
  { key: 'state', label: 'state' },
];

function groupCount(lanes: Lane[], filter: Filter, sort: Sort, now: number, showProbes: boolean): number {
  return groupLanesByTicket(visibleLanes(lanes, filter, sort, now, showProbes)).length;
}

export function Filters({
  filter, sort, repos, lanes, archivedLanes, showProbes, now, onFilter, onSort, onToggleProbes,
}: FiltersProps): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 0', flexWrap: 'wrap' }}>
      {BASE_FILTERS.map((f) => {
        const count = groupCount(lanes, f.key, sort, now, showProbes);
        const label = f.key === 'needs-me' ? `needs me · ${count} lanes` : `${f.label} ${count}`;
        return (
          <span key={f.key} className={`chip chipB ${filter === f.key ? 'chipOn' : ''}`} onClick={() => onFilter(f.key)}>
            {label}
          </span>
        );
      })}
      {repos.map((repo) => (
        <span key={repo} className={`chip chipB ${filter === repo ? 'chipOn' : ''}`} onClick={() => onFilter(repo)}>
          {repo}
        </span>
      ))}
      <span
        className={`chip chipB ${filter === 'archived' ? 'chipOn' : ''}`}
        onClick={() => onFilter('archived')}
      >
        Archived {archivedLanes.length}
      </span>
      <span className={`chip chipB ${showProbes ? 'chipOn' : ''}`} onClick={onToggleProbes}>
        Probes
      </span>
      <span style={{ flex: 1 }} />
      <span className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', whiteSpace: 'nowrap' }}>
        sort:
        {SORTS.map((s) => (
          <a
            key={s.key}
            style={{ fontWeight: sort === s.key ? 700 : 400, color: sort === s.key ? 'var(--ink)' : 'var(--ink2)', marginLeft: 6, textDecoration: 'none' }}
            onClick={() => onSort(s.key)}
          >
            {s.label}
          </a>
        ))}
      </span>
    </div>
  );
}
