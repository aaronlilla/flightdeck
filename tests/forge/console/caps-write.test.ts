import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import { ensureHardTokens, restoreCaps, writeCaps, type CapsWriteDeps } from '../../../src/forge/console/caps-write.js';

let dir: string;
let overridesPath: string;
let deps: CapsWriteDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-caps-'));
  overridesPath = join(dir, 'console', 'caps.json');
  mkdirSync(join(dir, 'console'), { recursive: true });
  deps = {
    journalPath: join(dir, 'fleet.jsonl'),
    ledger: new ActionsLedger(join(dir, 'actions.jsonl')),
    overridesPath,
    tokensToday: () => 3,
    governorConfigured: () => true,
  };
});

describe('writeCaps', () => {
  it('writes the new daily cap into ~/.forge/console/caps.json', async () => {
    const result = await writeCaps({ dailyTokens: 300_000 }, deps);

    expect(result.status).toBe(200);
    expect((result.body as { dailyTokens: number }).dailyTokens).toBe(300_000);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.dailyTokens).toBe(300_000);
  });

  it('refuses a daily cap above the hard limit with 422, and writes nothing', async () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyTokens: 100_000, hardTokens: 200_000 }), 'utf8');

    const result = await writeCaps({ dailyTokens: 999_000 }, deps);

    expect(result.status).toBe(422);
    expect((result.body as { hardTokens: number }).hardTokens).toBe(200_000);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.dailyTokens).toBe(100_000);
  });

  it('records an undo that restores the previous daily and run caps', async () => {
    await writeCaps({ dailyTokens: 300_000, runTokens: 80_000 }, deps);
    const row = deps.ledger.all().at(-1);

    expect(row?.undo).toEqual({ kind: 'restore-caps', payload: { dailyTokens: null, runTokens: null } });
  });

  it('reports console as the source for a field it just set, policy for one it did not touch', async () => {
    const result = await writeCaps({ dailyTokens: 300_000 }, deps);

    const caps = result.body as { sources: Record<string, 'policy' | 'console'> };
    expect(caps.sources.dailyTokens).toBe('console');
    expect(caps.sources.runTokens).toBe('policy');
  });
});

describe('ensureHardTokens', () => {
  it('writes 5x the daily cap into caps.json once a console daily cap exists', () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyTokens: 100_000 }), 'utf8');

    const result = ensureHardTokens(overridesPath);

    expect(result).toBe(500_000);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.hardTokens).toBe(500_000);
  });

  it('leaves an already-declared console hardTokens untouched', () => {
    writeFileSync(overridesPath, JSON.stringify({ hardTokens: 40_000 }), 'utf8');

    const result = ensureHardTokens(overridesPath);

    expect(result).toBe(40_000);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.hardTokens).toBe(40_000);
  });

  it('does not recompute a written hardTokens after dailyTokens changes', () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyTokens: 100_000 }), 'utf8');
    ensureHardTokens(overridesPath);
    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    overrides.dailyTokens = 5_000;
    writeFileSync(overridesPath, JSON.stringify(overrides), 'utf8');

    const result = ensureHardTokens(overridesPath);

    expect(result).toBe(500_000);
  });

  it('writes nothing and answers infinity with no console daily cap at all', () => {
    const result = ensureHardTokens(overridesPath);

    expect(result).toBe(Number.POSITIVE_INFINITY);
    expect(existsSync(overridesPath)).toBe(false);
  });
});

describe('restoreCaps', () => {
  it('puts a previous console override back', () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyTokens: 300_000, runTokens: 80_000 }), 'utf8');

    restoreCaps({ dailyTokens: 200_000, runTokens: 50_000 }, overridesPath);

    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.dailyTokens).toBe(200_000);
    expect(overrides.runTokens).toBe(50_000);
  });

  it('removes the override entirely when there was none before', () => {
    writeFileSync(overridesPath, JSON.stringify({ dailyTokens: 300_000, runTokens: 80_000 }), 'utf8');

    restoreCaps({ dailyTokens: null, runTokens: null }, overridesPath);

    const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    expect(overrides.dailyTokens).toBeUndefined();
    expect(overrides.runTokens).toBeUndefined();
  });
});
