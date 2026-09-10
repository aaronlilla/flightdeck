/**
 * The account-selection rule, against the fixture dev-harness is tested against too.
 *
 * There are two pickers on this machine: this one, and `coordination/accounts.py` in
 * dev-harness, which `go.py` and `forge/run.py` launch workers through. Two
 * implementations of one rule drift silently unless something notices, and this file
 * plus `coordination/test_accounts.py` are that something -- they read the SAME cases,
 * so a change made on one side and not the other turns both red.
 *
 * It fails, rather than skipping, when the fixture cannot be found. A silent skip is
 * exactly how the two rules would come apart without anyone hearing about it.
 */
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { pickAccount, type AccountProvider, type AccountRecord } from '../../src/forge/accounts.js';
import type { AccountUsage } from '../../src/forge/accounts-usage.js';

// The installed harness first, then the checkout it ships from. Deliberately not an
// environment variable: `vitest.config.ts` replaces the test environment wholesale, so
// an override there would silently do nothing -- worse than having no override.
const CANDIDATES = [
  'C:/dev/.claude/coordination/accounts-cases.json',
  'C:/dev/dev-harness/coordination/accounts-cases.json',
];

interface Case {
  name: string;
  accounts: { id: string; provider?: AccountProvider; configDir: string; connectedAt?: number }[];
  usage: AccountUsage;
  live?: Record<string, number>;
  now?: number;
  model?: string;
  provider?: AccountProvider;
  expect: string | null;
}

function loadFixture(): { now: number; provider: AccountProvider; cases: Case[] } {
  const found = CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `the shared account-selection fixture is missing. Looked at: ${CANDIDATES.join(', ')}. `
      + 'It ships from dev-harness (coordination/accounts-cases.json) and is what keeps this '
      + 'picker and the dev-harness picker implementing one rule. Install the harness, or '
      + 'check out dev-harness at C:/dev/dev-harness.',
    );
  }
  return JSON.parse(readFileSync(found, 'utf8')) as { now: number; provider: AccountProvider; cases: Case[] };
}

describe('the shared account-selection cases', () => {
  const fixture = loadFixture();

  it('has cases to run', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const accounts: AccountRecord[] = testCase.accounts.map((row) => ({
        id: row.id,
        provider: row.provider ?? 'claude',
        label: row.id,
        configDir: row.configDir,
        connectedAt: row.connectedAt ?? 0,
      }));
      const picked = pickAccount(
        accounts, testCase.usage, testCase.live ?? {}, testCase.now ?? fixture.now,
        testCase.provider ?? fixture.provider, testCase.model,
      );
      expect(picked?.id ?? null).toBe(testCase.expect);
    });
  }
});
