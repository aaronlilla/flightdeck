/**
 * Requirement 9 — a backend ticket ends at "draft PR open, [backend owner] pinged"; a
 * frontend ticket runs to merge (spine spec Section 2, "Planning per ticket"). Which repo
 * a ticket belongs to decides this, not a per-ticket choice — a governance boundary the
 * backend's controlled-code rule already draws (a stream never merges into the backend
 * on its own), restated here as data so the planner reads one function instead of a
 * scattered `if (repo === ...)`.
 */
export type RepoKind = 'backend' | 'frontend';

export interface TerminalState {
  stopsAt: 'draft-pr-open' | 'merged';
  pings: 'backend-owner' | undefined;
  runsToMerge: boolean;
}

export function terminalStateFor(kind: RepoKind): TerminalState {
  if (kind === 'backend') {
    return { stopsAt: 'draft-pr-open', pings: 'backend-owner', runsToMerge: false };
  }
  return { stopsAt: 'merged', pings: undefined, runsToMerge: true };
}
