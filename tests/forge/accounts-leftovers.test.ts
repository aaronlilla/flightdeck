/**
 * Login directories left behind after an unlink.
 *
 * Unlinking drops the registry row and leaves the directory, on purpose (Aaron,
 * 2026-09-10): it is hundreds of megabytes, deleting it is irreversible, and a kept
 * directory re-links with no browser login at all. So the files need their own way out,
 * and this is it.
 *
 * The shape matters more than the feature. A delete route that takes a PATH from the
 * browser is a remote arbitrary-delete waiting to happen, so nothing here accepts one:
 * a leftover is addressed by its directory NAME under `<FORGE_HOME>/accounts/configs`,
 * the name is matched against what is actually on disk, and a name belonging to a
 * registered account is refused. The traversal cases below are the ones that must stay
 * red-if-broken forever.
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { deleteLeftover, listLeftovers } from '../../src/forge/accounts-leftovers.js';
import { accountsRegistryPath, addAccount } from '../../src/forge/accounts.js';

let home: string;
let configs: string;
let registry: string;

function makeDir(name: string, bytes = 8): string {
  const dir = join(configs, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), 'x'.repeat(bytes), 'utf8');
  return dir;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-leftovers-'));
  process.env['FORGE_HOME'] = home;
  configs = join(home, 'accounts', 'configs');
  mkdirSync(configs, { recursive: true });
  registry = accountsRegistryPath();
});

describe('listLeftovers()', () => {
  it('is empty when nothing has ever been linked', () => {
    expect(listLeftovers(registry)).toEqual([]);
  });

  it('lists a directory with no registry row, with its size', () => {
    makeDir('claude-a', 16);
    const rows = listLeftovers(registry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('claude-a');
    expect(rows[0]?.bytes).toBeGreaterThanOrEqual(16);
  });

  it('does NOT list a directory a registered account is still using', () => {
    const dir = makeDir('claude-a');
    addAccount({ id: 'a', provider: 'claude', label: 'a', configDir: dir, connectedAt: 1 }, registry);
    expect(listLeftovers(registry)).toEqual([]);
  });

  it('lists the leftover and hides the live one when both exist', () => {
    const live = makeDir('claude-live');
    makeDir('claude-gone');
    addAccount({ id: 'live', provider: 'claude', label: 'live', configDir: live, connectedAt: 1 }, registry);
    expect(listLeftovers(registry).map((row) => row.name)).toEqual(['claude-gone']);
  });
});

describe('deleteLeftover()', () => {
  it('removes the directory and reports what it freed', () => {
    const dir = makeDir('claude-a', 32);
    const verdict = deleteLeftover('claude-a', registry);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok === true && verdict.bytes).toBeGreaterThanOrEqual(32);
    expect(existsSync(dir)).toBe(false);
  });

  it('REFUSES a directory a registered account is still using', () => {
    const dir = makeDir('claude-a');
    addAccount({ id: 'a', provider: 'claude', label: 'a', configDir: dir, connectedAt: 1 }, registry);
    const verdict = deleteLeftover('claude-a', registry);
    expect(verdict.ok).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses a name that is not there', () => {
    expect(deleteLeftover('claude-nope', registry).ok).toBe(false);
  });

  // The containment cases. Each of these is a remote arbitrary-delete if the check ever
  // stops working, so each gets its own assertion rather than one combined loop.
  it.each([
    ['..', 'the configs parent'],
    ['../..', 'the forge home'],
    ['../registry.json', 'a sibling file'],
    ['claude-a/..', 'a traversal that lands back on the parent'],
    ['/etc', 'an absolute posix path'],
    ['C:/Windows', 'an absolute windows path'],
    ['claude-a/nested', 'a nested path rather than one segment'],
    ['', 'an empty name'],
    ['.', 'the configs directory itself'],
  ])('refuses %j -- %s', (name) => {
    makeDir('claude-a');
    const verdict = deleteLeftover(name, registry);
    expect(verdict.ok).toBe(false);
    // Nothing outside the leftover was touched, and the leftover itself survives too.
    expect(existsSync(join(configs, 'claude-a'))).toBe(true);
    expect(existsSync(configs)).toBe(true);
    expect(existsSync(home)).toBe(true);
  });
});
