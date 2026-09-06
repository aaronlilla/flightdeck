import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import { hardUsdFor } from '../../../src/forge/console/caps-read.js';
import { ensureHardUsd, restoreCaps, writeCaps, type CapsWriteDeps } from '../../../src/forge/console/caps-write.js';

let dir: string;
let policyPath: string;
let overridesPath: string;
let deps: CapsWriteDeps;

function basePolicy(governor: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, classes: {}, governor };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-caps-'));
  policyPath = join(dir, 'model-policy.json');
  overridesPath = join(dir, 'console', 'caps.json');
  mkdirSync(join(dir, 'console'), { recursive: true });
  writeFileSync(policyPath, JSON.stringify(basePolicy({ dailyUsd: 20, usdPerRun: { implement: 5 } })), 'utf8');
  deps = {
    journalPath: join(dir, 'fleet.jsonl'),
    ledger: new ActionsLedger(join(dir, 'actions.jsonl')),
    policyPath,
    overridesPath,
    spentTodayUsd: () => 3,
  };
});

describe('hardUsdFor', () => {
  it('defaults to five times the daily cap when unset', () => {
    expect(hardUsdFor({ dailyUsd: 20, usdPerRun: {} })).toBe(100);
  });

  it('uses the declared hardUsd when present', () => {
    expect(hardUsdFor({ dailyUsd: 20, usdPerRun: {}, hardUsd: 40 })).toBe(40);
  });
});

describe('writeCaps', () => {
  it('writes the new daily cap into ~/.forge/console/caps.json, never the policy file', async () => {
    const result = await writeCaps({ dailyUsd: 30 }, deps);

    expect(result.status).toBe(200);
    expect((result.body as { dailyUsd: number }).dailyUsd).toBe(30);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.dailyUsd).toBe(30);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.dailyUsd).toBe(20);
  });

  it('refuses a daily cap above the hard limit with 422, and writes nothing', async () => {
    const result = await writeCaps({ dailyUsd: 999 }, deps);

    expect(result.status).toBe(422);
    expect((result.body as { hardUsd: number }).hardUsd).toBe(100);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.dailyUsd).toBe(20);
    expect(policy.governor.hardUsd).toBeUndefined();
  });

  it('records an undo that restores the previous daily and run caps', async () => {
    await writeCaps({ dailyUsd: 30, runUsd: 8 }, deps);
    const row = deps.ledger.all().at(-1);

    expect(row?.undo).toEqual({ kind: 'restore-caps', payload: { dailyUsd: null, runUsd: null } });
  });

  it('reports console as the source for a field it just overrode, policy for one it did not touch', async () => {
    const result = await writeCaps({ dailyUsd: 30 }, deps);

    const caps = result.body as { sources: Record<string, 'policy' | 'console'> };
    expect(caps.sources.dailyUsd).toBe('console');
    expect(caps.sources.runUsd).toBe('policy');
  });
});

describe('ensureHardUsd', () => {
  it('writes 5x the effective daily cap into caps.json, never the policy file', () => {
    const result = ensureHardUsd(policyPath, overridesPath);

    expect(result).toBe(100);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.hardUsd).toBe(100);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.hardUsd).toBeUndefined();
  });

  it('uses the console-overridden daily cap, not the policy one, once one is set', () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyUsd: 40 }), 'utf8');

    const result = ensureHardUsd(policyPath, overridesPath);

    expect(result).toBe(200);
  });

  it('leaves an already-declared console hardUsd untouched', () => {
    writeFileSync(overridesPath, JSON.stringify({ hardUsd: 40 }), 'utf8');

    const result = ensureHardUsd(policyPath, overridesPath);

    expect(result).toBe(40);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.hardUsd).toBe(40);
  });

  it('respects an hardUsd the policy file itself declares, and writes nothing', () => {
    writeFileSync(policyPath, JSON.stringify(basePolicy({ dailyUsd: 20, usdPerRun: {}, hardUsd: 75 })), 'utf8');

    const result = ensureHardUsd(policyPath, overridesPath);

    expect(result).toBe(75);
    expect(existsSync(overridesPath)).toBe(false);
  });

  it('does not recompute a written hardUsd after dailyUsd changes', () => {
    ensureHardUsd(policyPath, overridesPath);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.governor.dailyUsd = 5;
    writeFileSync(policyPath, JSON.stringify(policy), 'utf8');

    const result = ensureHardUsd(policyPath, overridesPath);

    expect(result).toBe(100);
  });

  it('writes nothing and answers infinity for a policy file with no governor block at all', () => {
    writeFileSync(policyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');

    const result = ensureHardUsd(policyPath, overridesPath);

    expect(result).toBe(Number.POSITIVE_INFINITY);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor).toBeUndefined();
  });
});

describe('restoreCaps', () => {
  it('puts a previous console override back', () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyUsd: 30, runUsd: 8 }), 'utf8');

    restoreCaps({ dailyUsd: 20, runUsd: 5 }, overridesPath);

    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.dailyUsd).toBe(20);
    expect(overrides.runUsd).toBe(5);
  });

  it('removes the override entirely when there was none before', () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyUsd: 30, runUsd: 8 }), 'utf8');

    restoreCaps({ dailyUsd: null, runUsd: null }, overridesPath);

    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.dailyUsd).toBeUndefined();
    expect(overrides.runUsd).toBeUndefined();
  });
});
