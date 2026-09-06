import type { JSX } from 'react';

import type { Lane } from '../../shared/console-model.js';
import type { Filter, Sort } from '../store.js';
import { visibleLanes } from './LanesGrid.js';

export interface FiltersProps {
  filter: Filter;
  sort: Sort;
  /** No longer used to build the repo chips -- see `REPO_FILTERS` -- kept so callers
   *  need not change; a caller-derived repo list never matched the prototype's fixed
   *  pair anyway. */
  repos: string[];
  lanes: Lane[];
  now: number;
  onFilter: (filter: Filter) => void;
  onSort: (sort: Sort) => void;
}

const BASE_FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'needs-me', label: 'needs me' },
  { key: 'running', label: 'running' },
  { key: 'finished', label: 'finished' },
];

/** The prototype always shows exactly these two repo chips (script_wrapped.txt 266),
 *  with no count appended -- unlike the base filters, which do carry one. */
const REPO_FILTERS = ['flightdeck-rn', 'flightdeck-api'];

const SORTS: { key: Sort; label: string }[] = [
  { key: 'cost', label: 'cost ↓' },
  { key: 'age', label: 'age' },
  { key: 'state', label: 'state' },
];

export function Filters({ filter, sort, lanes, now, onFilter, onSort }: FiltersProps): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 0', flexWrap: 'wrap' }}>
      {BASE_FILTERS.map((f) => {
        const count = visibleLanes(lanes, f.key, sort, now).length;
        const label = f.key === 'needs-me' ? `needs me · ${count} lanes` : `${f.label} ${count}`;
        return (
          <span key={f.key} className={`chip chipB ${filter === f.key ? 'chipOn' : ''}`} onClick={() => onFilter(f.key)}>
            {label}
          </span>
        );
      })}
      {REPO_FILTERS.map((repo) => (
        <span key={repo} className={`chip chipB ${filter === repo ? 'chipOn' : ''}`} onClick={() => onFilter(repo)}>
          {repo}
        </span>
      ))}
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
