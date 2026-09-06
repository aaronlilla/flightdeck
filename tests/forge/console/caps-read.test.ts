import { describe, expect, it } from 'vitest';

import { computeCaps, effectiveHardUsd, hardUsdFor } from '../../../src/forge/console/caps-read.js';

describe('hardUsdFor', () => {
  it('reads an explicit hardUsd off the governor block', () => {
    expect(hardUsdFor({ dailyUsd: 50, usdPerRun: {}, hardUsd: 300 })).toBe(300);
  });

  it('defaults to five times the daily cap when absent', () => {
    expect(hardUsdFor({ dailyUsd: 50, usdPerRun: {} })).toBe(250);
  });

  it('is infinite when the daily cap itself is unbounded', () => {
    expect(hardUsdFor({ dailyUsd: Number.POSITIVE_INFINITY, usdPerRun: {} })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('effectiveHardUsd', () => {
  it('uses a console-set hardUsd over anything computed from dailyUsd', () => {
    expect(effectiveHardUsd({ dailyUsd: 50, usdPerRun: {} }, { hardUsd: 999 })).toBe(999);
  });

  it('computes 5x the effective (overridden) daily cap, not the policy one', () => {
    expect(effectiveHardUsd({ dailyUsd: 50, usdPerRun: {} }, { dailyUsd: 80 })).toBe(400);
  });

  it('falls back to the policy governor block alone with no console overrides at all', () => {
    expect(effectiveHardUsd({ dailyUsd: 50, usdPerRun: {}, hardUsd: 300 }, {})).toBe(300);
  });
});

describe('computeCaps', () => {
  it('falls back to the implement class\'s per-run figure with no console override', () => {
    const caps = computeCaps({
      governor: { dailyUsd: 50, usdPerRun: { implement: 5 } },
      implementClassName: 'implement',
      overrides: {},
      spentTodayUsd: 12,
      governorConfigured: true,
    });
    expect(caps).toEqual({
      dailyUsd: 50, runUsd: 5, hardUsd: 250, enforcement: 'on', spentTodayUsd: 12, overrides: {},
      sources: { dailyUsd: 'policy', runUsd: 'policy', hardUsd: 'policy' },
    });
  });

  it('prefers a console override over the policy default, for both daily and per-run', () => {
    const caps = computeCaps({
      governor: { dailyUsd: 50, usdPerRun: { implement: 5 } },
      implementClassName: 'implement',
      overrides: { dailyUsd: 80, runUsd: 8, perRun: { alpha: 3 } },
      spentTodayUsd: 0,
      governorConfigured: true,
    });
    expect(caps.dailyUsd).toBe(80);
    expect(caps.runUsd).toBe(8);
    expect(caps.overrides).toEqual({ alpha: 3 });
    expect(caps.sources).toEqual({ dailyUsd: 'console', runUsd: 'console', hardUsd: 'policy' });
  });

  it('reports a console hardUsd override, distinct from dailyUsd and runUsd', () => {
    const caps = computeCaps({
      governor: { dailyUsd: 50, usdPerRun: {} },
      implementClassName: 'implement',
      overrides: { hardUsd: 999 },
      spentTodayUsd: 0,
      governorConfigured: true,
    });
    expect(caps.hardUsd).toBe(999);
    expect(caps.sources.hardUsd).toBe('console');
    expect(caps.sources.dailyUsd).toBe('policy');
  });

  it('reads enforcement off, for a policy file with no governor block', () => {
    const caps = computeCaps({
      governor: { dailyUsd: Number.POSITIVE_INFINITY, usdPerRun: {} },
      implementClassName: 'implement',
      overrides: {},
      spentTodayUsd: 0,
      governorConfigured: false,
    });
    expect(caps.enforcement).toBe('off');
  });
});
