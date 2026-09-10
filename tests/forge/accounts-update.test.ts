/**
 * Editing how an account may be spent: `lastResort` and `maxConcurrent`, the two fields
 * `pickAccount` ranks and filters on that nothing but the CLI could write.
 *
 * Both are one decision -- how much of this login the fleet may take -- so one writer
 * carries both, and it runs the candidate list through `validateAccounts` so a bad
 * ceiling is refused by exactly the rule every other write already applies.
 *
 * Real files under a temp `FORGE_HOME`, because the thing worth asserting is what ends
 * up ON DISK, not that a function was called.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  accountsRegistryPath, addAccount, loadAccounts, updateAccount, type AccountRecord,
} from '../../src/forge/accounts.js';

let path: string;

function seed(extra: Partial<AccountRecord> = {}): void {
  addAccount({
    id: 'a', provider: 'claude', label: 'a', configDir: '/accounts/a', connectedAt: 1000, ...extra,
  }, path);
}

beforeEach(() => {
  process.env['FORGE_HOME'] = mkdtempSync(join(tmpdir(), 'forge-accounts-update-'));
  path = accountsRegistryPath();
});

describe('updateAccount()', () => {
  it('sets lastResort and reads it back off disk', () => {
    seed();
    expect(updateAccount('a', { lastResort: true }, path)).toEqual({ ok: true });
    expect(loadAccounts(path)[0]?.lastResort).toBe(true);
  });

  it('clears lastResort rather than leaving a false lying around', () => {
    seed({ lastResort: true });
    updateAccount('a', { lastResort: false }, path);
    expect(loadAccounts(path)[0]?.lastResort).toBeUndefined();
  });

  it('sets a ceiling and reads it back off disk', () => {
    seed();
    updateAccount('a', { maxConcurrent: 3 }, path);
    expect(loadAccounts(path)[0]?.maxConcurrent).toBe(3);
  });

  it('treats 0 as "no limit" and clears the field', () => {
    // The stepper's zero position. Storing a literal 0 would be refused by
    // validateAccounts on the very next write, so it has to mean "unset".
    seed({ maxConcurrent: 4 });
    updateAccount('a', { maxConcurrent: 0 }, path);
    expect(loadAccounts(path)[0]?.maxConcurrent).toBeUndefined();
  });

  it('refuses a negative ceiling and leaves the row untouched', () => {
    seed({ maxConcurrent: 2 });
    const verdict = updateAccount('a', { maxConcurrent: -1 }, path);
    expect(verdict.ok).toBe(false);
    expect(loadAccounts(path)[0]?.maxConcurrent).toBe(2);
  });

  it('refuses a fractional ceiling and leaves the row untouched', () => {
    seed({ maxConcurrent: 2 });
    expect(updateAccount('a', { maxConcurrent: 1.5 }, path).ok).toBe(false);
    expect(loadAccounts(path)[0]?.maxConcurrent).toBe(2);
  });

  it('refuses an id that is not registered', () => {
    seed();
    const verdict = updateAccount('nope', { lastResort: true }, path);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('nope');
  });

  it('leaves every other field and every other row alone', () => {
    seed();
    addAccount({ id: 'b', provider: 'codex', label: 'b', configDir: '/accounts/b', connectedAt: 2000 }, path);
    updateAccount('a', { lastResort: true, maxConcurrent: 2 }, path);
    const [a, b] = loadAccounts(path);
    expect(a).toEqual({
      id: 'a', provider: 'claude', label: 'a', configDir: '/accounts/a', connectedAt: 1000,
      lastResort: true, maxConcurrent: 2,
    });
    expect(b).toEqual({ id: 'b', provider: 'codex', label: 'b', configDir: '/accounts/b', connectedAt: 2000 });
  });

  it('writes nothing when the patch carries neither field', () => {
    seed({ lastResort: true, maxConcurrent: 2 });
    expect(updateAccount('a', {}, path)).toEqual({ ok: true });
    expect(loadAccounts(path)[0]).toMatchObject({ lastResort: true, maxConcurrent: 2 });
  });
});
