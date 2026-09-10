/**
 * The account-selection rule, against the cases dev-harness is tested against too.
 *
 * There are two pickers on this machine: this one, and `coordination/accounts.py` in
 * dev-harness, which `go.py` and `forge/run.py` launch workers through. Two
 * implementations of one rule drift silently unless something notices.
 *
 * The fixture is VENDORED here rather than read from the harness repository. It used to
 * be read from an absolute path in that checkout, and that failed every CI run on both
 * runners, because the design assumed neither repository had CI -- true of the harness
 * repo, false of this one. A test that cannot pass off one machine is not fail-closed,
 * it is just broken. This repository has to stay machine agnostic, which its own
 * `check:agnostic` enforces.
 *
 * So the copy here is what this suite runs, and the check that the two copies have not
 * drifted apart lives in dev-harness (`coordination/test_accounts.py`), which has no CI
 * and runs only where both repositories exist -- which is also the only place either
 * file can be edited.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { interactiveSentence, pickAccount, type AccountProvider, type AccountRecord, type PickMode } from '../../src/forge/accounts.js';
import type { AccountUsage } from '../../src/forge/accounts-usage.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'accounts-cases.json');

interface Case {
  name: string;
  accounts: {
    id: string; provider?: AccountProvider; configDir: string; connectedAt?: number;
    maxConcurrent?: number; lastResort?: boolean; accountUuid?: string;
  }[];
  usage: AccountUsage;
  live?: Record<string, number>;
  now?: number;
  model?: string;
  provider?: AccountProvider;
  mode?: PickMode;
  expect: string | null;
}

interface SentenceCase {
  name: string;
  account: { id: string; label: string; email?: string };
  usage: AccountUsage;
  expect: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  now: number; provider: AccountProvider; cases: Case[]; sentences: SentenceCase[];
};

describe('the shared account-selection cases', () => {
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
        // Carried through explicitly: a field the fixture sets and this mapping drops is
        // a case that passes here while only the other picker really tests it. That
        // happened with lastResort and maxConcurrent.
        ...(row.maxConcurrent !== undefined ? { maxConcurrent: row.maxConcurrent } : {}),
        ...(row.lastResort !== undefined ? { lastResort: row.lastResort } : {}),
        ...(row.accountUuid !== undefined ? { accountUuid: row.accountUuid } : {}),
        // `mode` is carried the same way: a case whose mode this mapping dropped would
        // read as a worker pick and pass while testing nothing about a terminal.
      }));
      const picked = pickAccount(
        accounts, testCase.usage, testCase.live ?? {}, testCase.now ?? fixture.now,
        testCase.provider ?? fixture.provider, testCase.model, testCase.mode ?? 'worker',
      );
      expect(picked?.id ?? null).toBe(testCase.expect);
    });
  }
});

describe('the sentence a terminal prints', () => {
  // Two fixtures that differ only in how full the login is, each expecting its own
  // percent. `coordination/test_accounts.py` asserts the same three strings out of the
  // Python implementation, so one hardcoded sentence cannot satisfy both languages.
  for (const testCase of fixture.sentences) {
    it(testCase.name, () => {
      expect(interactiveSentence(testCase.account, fixture.now, testCase.usage)).toBe(testCase.expect);
    });
  }
});
