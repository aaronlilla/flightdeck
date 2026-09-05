/**
 * Requirement 9 — backend tickets end at "draft PR open, Joe pinged"; frontend tickets
 * run to merge (spine spec Section 2, "Planning per ticket").
 */
import { describe, expect, it } from 'vitest';

import { terminalStateFor } from '../../../src/forge/intake/handoff.js';

describe('terminalStateFor', () => {
  it('a backend-repo ticket ends at draft PR open with the backend owner pinged, never merge', () => {
    expect(terminalStateFor('backend')).toEqual({
      stopsAt: 'draft-pr-open', pings: 'backend-owner', runsToMerge: false,
    });
  });

  it('a frontend-repo ticket runs all the way to merge', () => {
    expect(terminalStateFor('frontend')).toEqual({
      stopsAt: 'merged', pings: undefined, runsToMerge: true,
    });
  });
});
