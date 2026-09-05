/**
 * The cost-shape signal: alive and wasting money, distinct from a hard context ceiling.
 */
import { describe, expect, it } from 'vitest';

import { assessCostShape } from '../../src/forge/cost-shape.js';
import { DEFAULT_WARDEN_CONFIG } from '../../src/forge/policy.js';

const NOW = 1_000_000_000;

function baseInput(overrides: Partial<Parameters<typeof assessCostShape>[0]> = {}) {
  return {
    run: 'r1', context: 300_000, cacheReadTokens: 270_000, totalReadTokens: 300_000,
    turnsSinceWrite: 30, now: NOW, ...overrides,
  };
}

describe('assessCostShape', () => {
  it('trips when context, cache-read ratio and turns-without-write all cross their thresholds', () => {
    const trip = assessCostShape(baseInput(), DEFAULT_WARDEN_CONFIG);
    expect(trip?.signal).toBe('cost-shape');
    expect(trip?.hint).toMatch(/alive and wasting money/);
    expect(trip?.hint).not.toMatch(/context ceiling reached/);
  });

  it('is silent when context is high but writes are still happening', () => {
    const trip = assessCostShape(baseInput({ turnsSinceWrite: 2 }), DEFAULT_WARDEN_CONFIG);
    expect(trip).toBeUndefined();
  });

  it('is silent when context is high but the reads are not mostly cache', () => {
    const trip = assessCostShape(baseInput({ cacheReadTokens: 10_000 }), DEFAULT_WARDEN_CONFIG);
    expect(trip).toBeUndefined();
  });

  it('is silent when context has not reached the threshold at all', () => {
    const trip = assessCostShape(baseInput({ context: 50_000 }), DEFAULT_WARDEN_CONFIG);
    expect(trip).toBeUndefined();
  });

  it("a specimen can't tell a cost-shape park from a plain context park by the hint alone -- proven false", () => {
    // The falsifier this guards against: the hint must say plainly this is not a
    // context-ceiling trip, so a report or a later specimen never conflates the two.
    const trip = assessCostShape(baseInput(), DEFAULT_WARDEN_CONFIG);
    expect(trip?.signal).not.toBe('context');
    expect(trip?.hint).toMatch(/not a context/);
  });
});
