import type { JSX } from 'react';

import { computeFreshness, freshnessClass, freshnessStamp } from '../freshness.js';

export interface FreshnessProps {
  verifiedAt: number | null;
  observedAt: number;
  feedLive: boolean;
  now: number;
  onEnter?: (event: React.MouseEvent) => void;
  onLeave?: () => void;
}

/** The `.stF` / `.stO` readout: `✓ verified Ns ago` lit, or `observed hh:mm` dashed. */
export function Freshness({ verifiedAt, observedAt, feedLive, now, onEnter, onLeave }: FreshnessProps): JSX.Element {
  const f = computeFreshness(verifiedAt, observedAt, feedLive, now);
  return (
    <span className={freshnessClass(f)} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {freshnessStamp(f)}
    </span>
  );
}
