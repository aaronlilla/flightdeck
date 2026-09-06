import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  computeCaps, effectiveHardTokens, readCapsOverrides, writeCapsOverrides,
} from '../../../src/forge/console/caps-read.js';

describe('effectiveHardTokens', () => {
  it('uses a console-set hardTokens over anything computed from dailyTokens', () => {
    expect(effectiveHardTokens({ dailyTokens: 50, hardTokens: 999 })).toBe(999);
  });

  it('computes 5x the console daily cap when no hard cap is set directly', () => {
    expect(effectiveHardTokens({ dailyTokens: 80 })).toBe(400);
  });

  it('is infinite when nothing has been set at all', () => {
    expect(effectiveHardTokens({})).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('computeCaps', () => {
  it('reads uncapped when no console override exists yet -- never a guess derived from the policy file', () => {
    const caps = computeCaps({ overrides: {}, tokensToday: 12, governorConfigured: true });
    expect(caps).toEqual({
      dailyTokens: Number.POSITIVE_INFINITY, runTokens: Number.POSITIVE_INFINITY, hardTokens: Number.POSITIVE_INFINITY,
      enforcement: 'on', tokensToday: 12, overrides: {},
      sources: { dailyTokens: 'policy', runTokens: 'policy', hardTokens: 'policy' },
    });
  });

  it('prefers a console override, for daily, per-run and the per-run overrides map alike', () => {
    const caps = computeCaps({
      overrides: { dailyTokens: 800_000, runTokens: 80_000, perRun: { alpha: 30_000 } },
      tokensToday: 0,
      governorConfigured: true,
    });
    expect(caps.dailyTokens).toBe(800_000);
    expect(caps.runTokens).toBe(80_000);
    expect(caps.overrides).toEqual({ alpha: 30_000 });
    expect(caps.sources).toEqual({ dailyTokens: 'console', runTokens: 'console', hardTokens: 'policy' });
  });

  it('reports a console hardTokens override, distinct from dailyTokens and runTokens', () => {
    const caps = computeCaps({ overrides: { hardTokens: 999 }, tokensToday: 0, governorConfigured: true });
    expect(caps.hardTokens).toBe(999);
    expect(caps.sources.hardTokens).toBe('console');
    expect(caps.sources.dailyTokens).toBe('policy');
  });

  it('reads enforcement off, purely from the governorConfigured flag', () => {
    const caps = computeCaps({ overrides: {}, tokensToday: 0, governorConfigured: false });
    expect(caps.enforcement).toBe('off');
  });
});

describe('readCapsOverrides migration', () => {
  function tempPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'caps-migrate-'));
    return join(dir, 'caps.json');
  }

  it('reads a token-shaped file straight through', () => {
    const path = tempPath();
    writeCapsOverrides(path, { dailyTokens: 500_000, runTokens: 50_000, perRun: { alpha: 10_000 } });
    expect(readCapsOverrides(path)).toEqual({ dailyTokens: 500_000, runTokens: 50_000, perRun: { alpha: 10_000 } });
  });

  it('drops a legacy dollar-shaped file rather than misreading a dollar figure as a token count', () => {
    const path = tempPath();
    // Written by an older console build, in dollars: an operator's real "$50/day" cap.
    writeCapsOverrides(path, { dailyUsd: 50, runUsd: 20, hardUsd: 100, perRun: { alpha: 8 } } as never);
    // Carrying 50 forward as "50 tokens" would be actively wrong (every real run would
    // read as instantly over cap), so a legacy key reads as unset rather than migrated
    // in place -- the file survives, the console just falls back to uncapped until the
    // operator sets a real token figure.
    expect(readCapsOverrides(path)).toEqual({});
    expect(existsSync(path)).toBe(true);
  });

  it('never throws on a file that will not parse as JSON at all', () => {
    const path = tempPath();
    writeCapsOverrides(path, {});
    // Corrupt it directly -- writeCapsOverrides always produces valid JSON.
    writeFileSync(path, '{not json', 'utf8');
    expect(readCapsOverrides(path)).toEqual({});
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });
});
