/**
 * The Forge policy file, read the way the runner reads it.
 *
 * Forge owns this policy now. dev-harness is frozen after Stage A, so its copy is the
 * last state of the old system rather than a second live source; the numbers were the
 * same on the day they parted and Stage C's cutover points the old conductor here.
 *
 * The rows that carry weight are the two about escalation. A class decides the model, a
 * brief may name a harder class, and nothing a run does to itself buys a bigger tier.
 * That is the whole reason this file exists.
 */
import { describe, expect, it } from 'vitest';

import {
  classFor,
  classNames,
  contextFor,
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_REASONER_TIMEOUT_MS,
  effectiveGovernorBudget,
  effortFor,
  governorBudget,
  loadPolicy,
  maxDiffLinesFor,
  modelFor,
  modelIdFor,
  priceFor,
  providerFor,
  reasonerTimeoutMs,
  reasonerTimeoutMsFor,
  tierOfBrief,
  turnsFor,
} from '../../src/forge/policy.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('the policy file', () => {
  it('declares every class the Spine names', () => {
    const wanted = [
      'triage', 'plan', 'master', 'implement', 'implement-hard', 'verify',
      'audit-lens', 'audit-judge', 'research', 'evaluate', 'sweep',
    ];
    expect(classNames().sort()).toEqual(wanted.sort());
  });

  it('gives every class a model, an effort, a context ceiling and a turn cap', () => {
    for (const name of classNames()) {
      const spec = classFor(name);
      expect(spec.model).toBeTruthy();
      expect(spec.maxContext).toBeGreaterThan(0);
      expect(spec.maxTurns).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(spec.effort);
    }
  });

  it('runs implementation on sonnet and only implement-hard on opus', () => {
    expect(modelFor('implement')).toBe('sonnet');
    expect(modelFor('implement-hard')).toBe('opus');
    expect(modelFor('plan')).toBe('fable');
  });

  it('caps an implement session at 150000 tokens', () => {
    expect(contextFor('implement')).toBe(150_000);
    expect(turnsFor('implement')).toBeGreaterThan(0);
    expect(effortFor('implement')).toBe('medium');
  });

  it('keeps the master cheap enough to stay a master', () => {
    expect(modelFor('master')).toBe('fable');
    expect(contextFor('master')).toBeLessThanOrEqual(30_000);
  });

  it('refuses a class nobody declared rather than guessing one', () => {
    expect(() => classFor('no-such-class')).toThrow(/no-such-class/);
  });

  it('maps a tier alias to the id a session reports', () => {
    expect(modelIdFor('sonnet')).toBe('claude-sonnet-5');
    expect(modelIdFor('fable')).toBe('claude-fable-5');
  });

  it('says escalation never comes from a retry', () => {
    expect(loadPolicy().escalation).toBe('never-by-retry');
  });

  it('prices a tier so the burn ledger has something to add up', () => {
    expect(priceFor('opus').cacheRead).toBeGreaterThan(priceFor('sonnet').cacheRead);
  });
});

describe('the tier a brief asks for', () => {
  it('reads an explicit tier line as implement-hard', () => {
    expect(tierOfBrief('# Goal\n\ntier: opus\n\nbody\n')).toBe('implement-hard');
  });

  it('reads the same line inside front matter', () => {
    expect(tierOfBrief('---\ntier: opus\n---\n\nbody\n')).toBe('implement-hard');
  });

  it('leaves a brief with no tier line on the ordinary class', () => {
    expect(tierOfBrief('# Goal\n\nprose about opus and how hard this is\n')).toBe('implement');
  });

  it('does not read an argument about opus as a decision', () => {
    expect(tierOfBrief('The tier: opus question was settled elsewhere in this sentence.'))
      .toBe('implement');
  });

  it('ignores a tier nobody declared', () => {
    expect(tierOfBrief('tier: gigantic\n')).toBe('implement');
  });

  it('is unmoved by how many times a goal has failed', () => {
    // There is no argument to pass. That is the point: nothing about a run's history
    // reaches this function, so no amount of failing can raise its tier.
    expect(tierOfBrief('')).toBe('implement');
  });
});

describe('wardenConfig', () => {
  it('reads the cost-shape thresholds off the real policy file', async () => {
    const { wardenConfig } = await import('../../src/forge/policy.js');
    const config = wardenConfig();
    expect(config.contextHigh).toBeGreaterThan(0);
    expect(config.cacheReadRatio).toBeGreaterThan(0);
    expect(config.turnsWithoutWrite).toBeGreaterThan(0);
  });

  it('falls back to the spec defaults for a policy file with no warden block', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'forge-policy-nowarden-'));
    const path = join(dir, 'model-policy.json');
    writeFileSync(path, JSON.stringify({
      version: 1, escalation: 'never-by-retry', fallback: {}, aliases: {},
      interactive: { warnContext: 1 }, prices: {}, classes: { evaluate: { model: 'haiku', effort: 'low', maxContext: 1, maxTurns: 1 } },
      brief_tiers: {}, subagents: {},
    }), 'utf8');
    const { wardenConfig, DEFAULT_WARDEN_CONFIG } = await import('../../src/forge/policy.js');
    expect(wardenConfig(path)).toEqual(DEFAULT_WARDEN_CONFIG);
  });
});

describe('provider, read from the policy file rather than hardcoded', () => {
  it('sends plan and master to codex, per the 2026-09-04 13:20 decision', () => {
    expect(providerFor('plan')).toBe('codex');
    expect(providerFor('master')).toBe('codex');
  });

  it('defaults every other declared class to claude', () => {
    for (const name of classNames()) {
      if (name === 'plan' || name === 'master') continue;
      expect(providerFor(name)).toBe('claude');
    }
  });

  it('refuses to guess a provider for a class nobody declared', () => {
    expect(() => providerFor('no-such-class')).toThrow(/no-such-class/);
  });
});

describe('the governor budget block', () => {
  it('has generous defaults rather than an unset cap silently meaning unlimited', () => {
    const budget = governorBudget();
    expect(budget.dailyUsd).toBeGreaterThan(0);
    expect(Number.isFinite(budget.dailyUsd)).toBe(true);
  });

  it('gives implement-hard a higher per-run ceiling than triage', () => {
    const budget = governorBudget();
    expect(budget.usdPerRun['implement-hard']).toBeGreaterThan(budget.usdPerRun['triage'] ?? 0);
  });

  it('never parks a run on the file this stream ships, since a real cap is set', () => {
    const budget = governorBudget();
    expect(Object.keys(budget.usdPerRun).length).toBeGreaterThan(0);
  });
});

describe('effectiveGovernorBudget: governorBudget() merged with a console override', () => {
  function policyFile(governor: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const path = join(dir, 'model-policy.json');
    writeFileSync(path, JSON.stringify({ version: 1, classes: {}, governor }), 'utf8');
    return path;
  }

  function homeWithOverrides(overrides: Record<string, unknown> | null): string {
    const home = mkdtempSync(join(tmpdir(), 'forge-home-'));
    if (overrides) {
      mkdirSync(join(home, 'console'), { recursive: true });
      writeFileSync(join(home, 'console', 'caps.json'), JSON.stringify(overrides), 'utf8');
    }
    return home;
  }

  it('reads the policy file straight when the console has overridden nothing', () => {
    const path = policyFile({ dailyUsd: 50, usdPerRun: { implement: 5 } });
    const budget = effectiveGovernorBudget(path, homeWithOverrides(null));
    expect(budget.dailyUsd).toBe(50);
    expect(budget.usdPerRun['implement']).toBe(5);
  });

  it('lets a console dailyUsd override the policy figure', () => {
    const path = policyFile({ dailyUsd: 50, usdPerRun: {} });
    const budget = effectiveGovernorBudget(path, homeWithOverrides({ dailyUsd: 80 }));
    expect(budget.dailyUsd).toBe(80);
  });

  it('mirrors a console runUsd override onto both implement and default', () => {
    const path = policyFile({ dailyUsd: 50, usdPerRun: { implement: 5, default: 5 } });
    const budget = effectiveGovernorBudget(path, homeWithOverrides({ runUsd: 12 }));
    expect(budget.usdPerRun['implement']).toBe(12);
    expect(budget.usdPerRun['default']).toBe(12);
  });

  it('carries a console hardUsd override through onto the merged budget', () => {
    const path = policyFile({ dailyUsd: 50, usdPerRun: {} });
    const budget = effectiveGovernorBudget(path, homeWithOverrides({ hardUsd: 999 }));
    expect(budget.hardUsd).toBe(999);
  });

  it('never writes the policy file for the override itself', () => {
    const path = policyFile({ dailyUsd: 50, usdPerRun: {} });
    const before = readFileSync(path, 'utf8');
    effectiveGovernorBudget(path, homeWithOverrides({ dailyUsd: 80 }));
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('reasonerTimeoutMs', () => {
  it('reads the checked-in policy file\'s own 120s budget', () => {
    expect(reasonerTimeoutMs()).toBe(120_000);
  });

  it('falls back to the default when a policy file names none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-policy-'));
    const fixture = join(dir, 'model-policy.json');
    const withoutTimeout = { ...loadPolicy(), reasoner: { astra: 'off' as const } };
    writeFileSync(fixture, JSON.stringify(withoutTimeout));
    expect(reasonerTimeoutMs(fixture)).toBe(DEFAULT_REASONER_TIMEOUT_MS);
  });

  it('honours an override the policy file sets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-policy-'));
    const fixture = join(dir, 'model-policy.json');
    const withOverride = { ...loadPolicy(), reasoner: { astra: 'off' as const, timeoutMs: 5000 } };
    writeFileSync(fixture, JSON.stringify(withOverride));
    expect(reasonerTimeoutMs(fixture)).toBe(5000);
  });
});

describe('reasonerTimeoutMsFor: a class may need longer than the fleet-wide default (GATE.md item 3)', () => {
  it('the checked-in audit-lens class gets more than the bare 120s default -- BBZ-99 timed out at exactly that', () => {
    expect(reasonerTimeoutMsFor('audit-lens')).toBeGreaterThan(DEFAULT_REASONER_TIMEOUT_MS);
  });

  it('a class with no timeoutMs of its own falls back to the fleet-wide reasoner.timeoutMs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-policy-'));
    const fixture = join(dir, 'model-policy.json');
    const policy = { ...loadPolicy(), reasoner: { astra: 'off' as const, timeoutMs: 7000 } };
    writeFileSync(fixture, JSON.stringify(policy));
    expect(reasonerTimeoutMsFor('audit-judge', fixture)).toBe(7000);
  });

  it('a class that names its own timeoutMs overrides the fleet-wide default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-policy-'));
    const fixture = join(dir, 'model-policy.json');
    const base = loadPolicy();
    const policy = {
      ...base,
      classes: { ...base.classes, 'audit-lens': { ...base.classes['audit-lens']!, timeoutMs: 42_000 } },
    };
    writeFileSync(fixture, JSON.stringify(policy));
    expect(reasonerTimeoutMsFor('audit-lens', fixture)).toBe(42_000);
  });
});

// C.2: the diff a lens reads is capped per hunk, N read from the audit-lens class so
// tuning it is a data change, never a code change -- same shape as timeoutMs above.
describe('maxDiffLinesFor: the per-hunk cap a lens\'s diff is read at', () => {
  it('falls back to 400 when the checked-in policy names no maxDiffLines of its own', () => {
    expect(maxDiffLinesFor('audit-lens')).toBe(DEFAULT_MAX_DIFF_LINES);
    expect(DEFAULT_MAX_DIFF_LINES).toBe(400);
  });

  it('honours a maxDiffLines the audit-lens class sets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-policy-'));
    const fixture = join(dir, 'model-policy.json');
    const base = loadPolicy();
    const policy = {
      ...base,
      classes: { ...base.classes, 'audit-lens': { ...base.classes['audit-lens']!, maxDiffLines: 250 } },
    };
    writeFileSync(fixture, JSON.stringify(policy));
    expect(maxDiffLinesFor('audit-lens', fixture)).toBe(250);
  });

  it('a class with no maxDiffLines of its own still falls back to the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-policy-'));
    const fixture = join(dir, 'model-policy.json');
    writeFileSync(fixture, JSON.stringify(loadPolicy()));
    expect(maxDiffLinesFor('audit-judge', fixture)).toBe(DEFAULT_MAX_DIFF_LINES);
  });
});
