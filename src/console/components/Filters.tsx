import type { JSX } from 'react';

import type { Lane } from '../../shared/console-model.js';
import type { Filter, Sort } from '../store.js';
import { visibleLanes } from './LanesGrid.js';

export interface FiltersProps {
  filter: Filter;
  sort: Sort;
  repos: string[];
  lanes: Lane[];
  onFilter: (filter: Filter) => void;
  onSort: (sort: Sort) => void;
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

export function Filters({ filter, sort, repos, lanes, onFilter, onSort }: FiltersProps): JSX.Element {
  const chips = [...BASE_FILTERS, ...repos.map((r) => ({ key: r, label: r }))];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 0', flexWrap: 'wrap' }}>
      {chips.map((f) => (
        <span key={f.key} className={`chip chipB ${filter === f.key ? 'chipOn' : ''}`} onClick={() => onFilter(f.key)}>
          {f.label} {visibleLanes(lanes, f.key, sort).length}
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
