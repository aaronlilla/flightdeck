/**
 * Requirement 11: Governor coalesces EAS builds (F23), Warden owns single-flight
 * credential recovery (F24). Both are deferred to Intake's neighbors, per the spine
 * spec's "the lanes" section, and this stream never builds either — the boundary is
 * declared here as data, and `boundary.test.ts` scans this whole directory's source to
 * keep it true rather than trusting a comment to stay accurate.
 */
export interface DeferredConcern {
  concern: string;
  owner: 'governor' | 'warden';
}

export const DEFERRED_TO_NEIGHBORS: DeferredConcern[] = [
  { concern: 'eas-build-coalescing', owner: 'governor' },
  { concern: 'single-flight-credential-recovery', owner: 'warden' },
];
