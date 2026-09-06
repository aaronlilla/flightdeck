import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import {
  ensureHardUsd, hardUsdOf, restoreCaps, writeCaps, type CapsWriteDeps,
} from '../../../src/forge/console/caps-write.js';

let dir: string;
let policyPath: string;
let deps: CapsWriteDeps;

function basePolicy(governor: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, classes: {}, governor };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-caps-'));
  policyPath = join(dir, 'model-policy.json');
  writeFileSync(policyPath, JSON.stringify(basePolicy({ dailyUsd: 20, usdPerRun: { implement: 5 } })), 'utf8');
  deps = {
    journalPath: join(dir, 'fleet.jsonl'),
    ledger: new ActionsLedger(join(dir, 'actions.jsonl')),
    policyPath,
    spentTodayUsd: () => 3,
  };
});

describe('hardUsdOf', () => {
  it('defaults to five times the daily cap when unset', () => {
    expect(hardUsdOf({ dailyUsd: 20, usdPerRun: {} })).toBe(100);
  });

  it('uses the declared hardUsd when present', () => {
    expect(hardUsdOf({ dailyUsd: 20, usdPerRun: {}, hardUsd: 40 })).toBe(40);
  });
});

describe('writeCaps', () => {
  it('writes the new daily cap into the policy file governor block', async () => {
    const result = await writeCaps({ dailyUsd: 30 }, deps);

    expect(result.status).toBe(200);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.dailyUsd).toBe(30);
  });

  it('refuses a daily cap above the hard limit with 422', async () => {
    const result = await writeCaps({ dailyUsd: 999 }, deps);

    expect(result.status).toBe(422);
    expect((result.body as { hardUsd: number }).hardUsd).toBe(100);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.dailyUsd).toBe(20);
  });

  it('records an undo that restores the previous daily and run caps', async () => {
    await writeCaps({ dailyUsd: 30, runUsd: 8 }, deps);
    const row = deps.ledger.all().at(-1);

    expect(row?.undo).toEqual({ kind: 'restore-caps', payload: { dailyUsd: 20, runUsd: 5 } });
  });
});

describe('ensureHardUsd', () => {
  it('writes 5x dailyUsd into the policy file governor block on first read', () => {
    const result = ensureHardUsd(policyPath);

    expect(result).toBe(100);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.hardUsd).toBe(100);
  });

  it('leaves an already-declared hardUsd untouched', () => {
    writeFileSync(policyPath, JSON.stringify(basePolicy({ dailyUsd: 20, usdPerRun: {}, hardUsd: 40 })), 'utf8');

    const result = ensureHardUsd(policyPath);

    expect(result).toBe(40);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.hardUsd).toBe(40);
  });

  it('does not recompute a written hardUsd after dailyUsd changes', () => {
    ensureHardUsd(policyPath);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.governor.dailyUsd = 5;
    writeFileSync(policyPath, JSON.stringify(policy), 'utf8');

    const result = ensureHardUsd(policyPath);

    expect(result).toBe(100);
  });

  it('writes nothing and answers infinity for a policy file with no governor block at all', () => {
    writeFileSync(policyPath, JSON.stringify({ version: 1, classes: {} }), 'utf8');

    const result = ensureHardUsd(policyPath);

    expect(result).toBe(Number.POSITIVE_INFINITY);
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor).toBeUndefined();
  });
});

describe('restoreCaps', () => {
  it('puts the governor block back to a previous daily and run cap', () => {
    restoreCaps({ dailyUsd: 20, runUsd: 5 }, policyPath);

    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    expect(policy.governor.dailyUsd).toBe(20);
    expect(policy.governor.usdPerRun.implement).toBe(5);
  });
});
