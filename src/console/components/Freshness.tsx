import type { JSX } from 'react';
/**
 * Renders the P6.3 distinction: a value read fresh from its source
 * (`verifiedAt` set) against one only ever observed in memory (`observedAt`
 * alone). The two must never look the same, per the truth auditor's closing
 * condition ("stale events render with both values").
 */
import { useMemo } from 'react';

export interface FreshnessProps {
  verifiedAt?: number;
  observedAt?: number;
  now?: number;
}

function ageLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function Freshness({ verifiedAt, observedAt, now }: FreshnessProps): JSX.Element {
  const clock = now ?? Date.now();
  const verified = typeof verifiedAt === 'number';
  const at = verified ? verifiedAt! : observedAt;
  const label = useMemo(() => {
    if (typeof at !== 'number') return verified ? 'verified' : 'observed, unverified';
    const age = ageLabel(at, clock);
    return verified ? `verified ${age}` : `observed only, ${age}`;
  }, [at, clock, verified]);

  return (
    <span
      className={`freshness ${verified ? 'freshness--verified' : 'freshness--observed'}`}
      data-freshness={verified ? 'verified' : 'observed'}
      title={verified ? 'read fresh from its source' : 'not confirmed against its source since this was recorded'}
    >
      <span className="freshness__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
