import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { watcherLine } from '../sync-text.js';
import type { WatcherStatus as WatcherStatusModel } from '../../shared/sync-contract.js';

export interface WatcherStatusProps {
  status: WatcherStatusModel;
  onToggle: (on: boolean) => void;
}

/** The header's watcher line (R-71): re-rendered every second so the countdown moves,
 *  plus a small on/off control next to the project key. */
export function WatcherStatus({ status, onToggle }: WatcherStatusProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span data-testid="watcher-line">{watcherLine(status, now)}</span>
      <button
        type="button"
        data-testid="watcher-toggle"
        onClick={() => onToggle(!status.on)}
        style={{ font: 'inherit', color: 'inherit', background: 'none', border: '1px solid var(--line)', padding: '1px 6px', cursor: 'pointer' }}
      >
        {status.on ? 'Watcher off' : 'Watcher on'}
      </button>
    </span>
  );
}
