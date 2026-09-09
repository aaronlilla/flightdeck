/**
 * The account registry: `~/.forge/accounts/registry.json`, mapping a connected Claude
 * account to the config directory its sessions authenticate through. No probe, no
 * network call, no process spawn here -- this is the plain read/write layer
 * `accounts-connect.ts` and the console routes build on.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  accountsRegistryPath, addAccount, liveRunsByAccount, loadAccounts, removeAccount,
} from '../../src/forge/accounts.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-accounts-'));
  process.env['FORGE_HOME'] = dir;
  path = accountsRegistryPath();
});

describe('the account registry file', () => {
  it('reads an empty list when no registry file exists yet', () => {
    expect(loadAccounts(path)).toEqual([]);
  });

  it('adds an account and reads it back', () => {
    addAccount({ id: 'test-a', provider: 'claude', label: 'work', configDir: '/accounts/test-a', connectedAt: 1000 }, path);
    const accounts = loadAccounts(path);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({ id: 'test-a', provider: 'claude', label: 'work', configDir: '/accounts/test-a', connectedAt: 1000 });
  });

  it('adds a second account alongside the first, rather than overwriting it', () => {
    addAccount({ id: 'test-a', provider: 'claude', label: 'work', configDir: '/accounts/test-a', connectedAt: 1000 }, path);
    addAccount({ id: 'test-b', provider: 'claude', label: 'personal', configDir: '/accounts/test-b', connectedAt: 2000 }, path);
    expect(loadAccounts(path).map((a) => a.id)).toEqual(['test-a', 'test-b']);
  });

  it('removes an account by id, leaving the rest untouched', () => {
    addAccount({ id: 'test-a', provider: 'claude', label: 'work', configDir: '/accounts/test-a', connectedAt: 1000 }, path);
    addAccount({ id: 'test-b', provider: 'claude', label: 'personal', configDir: '/accounts/test-b', connectedAt: 2000 }, path);
    removeAccount('test-a', path);
    expect(loadAccounts(path).map((a) => a.id)).toEqual(['test-b']);
  });

  it('removing an id that is not there is a no-op, not a throw', () => {
    addAccount({ id: 'test-a', provider: 'claude', label: 'work', configDir: '/accounts/test-a', connectedAt: 1000 }, path);
    expect(() => removeAccount('test-nope', path)).not.toThrow();
    expect(loadAccounts(path)).toHaveLength(1);
  });

  it('tolerates a torn or missing registry file by reading an empty list', () => {
    // No file written at all yet -- addAccount must create the directory itself.
    expect(loadAccounts(join(dir, 'nowhere', 'registry.json'))).toEqual([]);
  });
});

describe('liveRunsByAccount: counted fresh from events and the currently live goals', () => {
  it('counts a run against the account its run.started row named', () => {
    const events = [
      { event: 'run.started', run: 'goal-1', actor: 'runner', account: 'test-a' },
      { event: 'run.started', run: 'goal-2', actor: 'runner', account: 'test-b' },
    ] as never[];
    expect(liveRunsByAccount(events, ['goal-1', 'goal-2'])).toEqual({ 'test-a': 1, 'test-b': 1 });
  });

  it('never counts a goal that is no longer live, even if it once ran on this account', () => {
    const events = [
      { event: 'run.started', run: 'goal-1', actor: 'runner', account: 'test-a' },
    ] as never[];
    // goal-1 finished (it is not in the live-goals list any more).
    expect(liveRunsByAccount(events, [])).toEqual({});
  });

  it('sums more than one live run on the same account', () => {
    const events = [
      { event: 'run.started', run: 'goal-1', actor: 'runner', account: 'test-a' },
      { event: 'run.started', run: 'goal-2', actor: 'runner', account: 'test-a' },
    ] as never[];
    expect(liveRunsByAccount(events, ['goal-1', 'goal-2'])).toEqual({ 'test-a': 2 });
  });
});
