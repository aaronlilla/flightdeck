/**
 * always-on-warden R-55: elapsedGlance surfaces the clock's own elapsed time as plain
 * English for the lane tile ("running 42 min"), the way Aaron asked for it -- no device,
 * no UI beyond this string.
 */
import { describe, expect, it } from 'vitest';

import { elapsedGlance } from '../../../src/forge/console/laneGlance.js';

describe('elapsedGlance', () => {
  it('reports minutes under an hour', () => {
    expect(elapsedGlance(0, 42 * 60_000)).toBe('running 42 min');
  });

  it('reports hours to one decimal past 60 minutes', () => {
    expect(elapsedGlance(0, 90 * 60_000)).toBe('running 1.5 h');
  });

  it('returns null for a run with no startedAt, rather than guessing', () => {
    expect(elapsedGlance(undefined, 1_000_000)).toBeNull();
  });
});
