import type { JSX } from 'react';
import type { LaneRecord } from '../types.js';
import { LaneTile } from './LaneTile.js';

export interface LanesGridProps {
  lanes: LaneRecord[];
  now?: number;
  disabledReason?: string;
  onSend: (run: string, text: string) => Promise<void>;
  onClear: (lane: string) => Promise<void>;
  onOpen?: (slug: string) => void;
}

export function LanesGrid({ lanes, now, disabledReason, onSend, onClear, onOpen }: LanesGridProps): JSX.Element {
  if (lanes.length === 0) {
    return (
      <div className="lanes-grid">
        <div className="lanes-empty">Nothing running. Start the fleet to see lanes here.</div>
      </div>
    );
  }

  return (
    <div className="lanes-grid">
      {lanes.map((lane) => (
        <LaneTile
          key={lane.slug}
          lane={lane}
          now={now}
          disabledReason={disabledReason}
          onSend={onSend}
          onClear={onClear}
          {...(onOpen ? { onOpen } : {})}
        />
      ))}
    </div>
  );
}
