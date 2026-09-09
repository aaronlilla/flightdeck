/**
 * The connect/disconnect flow for a second (and third, ...) Claude account.
 *
 * Every specimen here drives `AccountsConnect` with fake `spawnLogin`/`probeStatus`
 * functions -- nothing spawns a real `claude` process, and no browser link or auth
 * error text is ever asserted to reach anywhere but the object this module hands back
 * directly to its caller.
 */
import { describe, expect, it, vi } from 'vitest';

import { AccountsConnect } from '../../src/forge/accounts-connect.js';
import type { AccountRecord } from '../../src/forge/accounts.js';

function makeDeps() {
  let accounts: AccountRecord[] = [];
  let idCounter = 0;
  let liveByAccount: Record<string, number> = {};
  return {
    accountsRef: () => accounts,
    setLive: (value: Record<string, number>) => { liveByAccount = value; },
    deps: {
      loadAccounts: () => accounts,
      addAccount: (record: AccountRecord) => { accounts = [...accounts, record]; },
      removeAccount: (id: string) => { accounts = accounts.filter((a) => a.id !== id); },
      liveRunCount: (id: string) => liveByAccount[id] ?? 0,
      spawnLogin: vi.fn(async (_configDir: string): Promise<{ ok: boolean; link?: string; error?: string }> => ({ ok: true, link: 'https://example.test/authorize/abc' })),
      probeStatus: vi.fn(async (_configDir: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
      logout: vi.fn(async (_configDir: string): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
      now: () => 1_000,
      randomId: () => `id-${idCounter++}`,
    },
  };
}

async function untilSettled(connect: AccountsConnect, attemptId: string, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const attempt = connect.getAttempt(attemptId);
    if (attempt?.state === 'connected' || attempt?.state === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('starting a connect attempt', () => {
  it('runs connecting -> waiting-in-browser -> probing -> connected, and adds the account', async () => {
    const { deps, accountsRef } = makeDeps();
    const connect = new AccountsConnect(deps);
    const started = connect.startConnect('work');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await untilSettled(connect, started.attemptId);
    const attempt = connect.getAttempt(started.attemptId);
    expect(attempt?.state).toBe('connected');
    expect(attempt?.link).toBe('https://example.test/authorize/abc');
    expect(accountsRef()).toHaveLength(1);
    expect(accountsRef()[0]?.label).toBe('work');
  });

  it('fails cleanly when the probe fails, leaving the registry unchanged', async () => {
    const { deps, accountsRef } = makeDeps();
    deps.probeStatus = vi.fn(async () => ({ ok: false, error: 'not authenticated' }));
    const connect = new AccountsConnect(deps);
    const started = connect.startConnect('work');
    if (!started.ok) throw new Error('expected ok');

    await untilSettled(connect, started.attemptId);
    const attempt = connect.getAttempt(started.attemptId);
    expect(attempt?.state).toBe('failed');
    expect(attempt?.error).toBe('not authenticated');
    expect(accountsRef()).toHaveLength(0);
  });

  it('fails cleanly when the login step itself fails', async () => {
    const { deps, accountsRef } = makeDeps();
    deps.spawnLogin = vi.fn(async () => ({ ok: false, error: 'browser flow timed out' }));
    const connect = new AccountsConnect(deps);
    const started = connect.startConnect('work');
    if (!started.ok) throw new Error('expected ok');

    await untilSettled(connect, started.attemptId);
    const attempt = connect.getAttempt(started.attemptId);
    expect(attempt?.state).toBe('failed');
    expect(attempt?.error).toBe('browser flow timed out');
    expect(accountsRef()).toHaveLength(0);
    expect(deps.probeStatus).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent attempt for the same label', () => {
    const { deps } = makeDeps();
    let resolveLogin: (value: { ok: boolean; link?: string }) => void = () => {};
    deps.spawnLogin = vi.fn(() => new Promise<{ ok: boolean; link?: string }>((resolve) => { resolveLogin = resolve; }));
    const connect = new AccountsConnect(deps);
    const first = connect.startConnect('work');
    expect(first.ok).toBe(true);

    const second = connect.startConnect('work');
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected refusal');
    expect(second.error).toMatch(/already/i);

    resolveLogin({ ok: true, link: 'https://example.test' });
  });

  it('refuses a config-dir collision before spawning anything', () => {
    const { deps, accountsRef } = makeDeps();
    void accountsRef;
    deps.loadAccounts = () => [{ id: 'test-a', label: 'work', configDir: '/accounts/work', connectedAt: 0 }];
    const connect = new AccountsConnect(deps, { configDirFor: () => '/accounts/work' });
    const result = connect.startConnect('work-2');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/collision/i);
    expect(deps.spawnLogin).not.toHaveBeenCalled();
  });
});

describe('disconnecting an account', () => {
  function connectWith(accounts: AccountRecord[], live: Record<string, number> = {}) {
    const { deps } = makeDeps();
    deps.loadAccounts = () => accounts;
    deps.liveRunCount = (id: string) => live[id] ?? 0;
    return new AccountsConnect(deps);
  }

  it('refuses to remove the last remaining account', async () => {
    const connect = connectWith([{ id: 'test-a', label: 'only', configDir: '/a', connectedAt: 0 }]);
    const result = await connect.disconnect('test-a');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/last/i);
  });

  it('refuses to remove an account with live runs', async () => {
    const connect = connectWith(
      [
        { id: 'test-a', label: 'one', configDir: '/a', connectedAt: 0 },
        { id: 'test-b', label: 'two', configDir: '/b', connectedAt: 0 },
      ],
      { 'test-a': 2 },
    );
    const result = await connect.disconnect('test-a');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/run/i);
  });

  it('removes an account with no live runs when another account remains', async () => {
    const removeAccount = vi.fn();
    const { deps } = makeDeps();
    deps.loadAccounts = () => [
      { id: 'test-a', label: 'one', configDir: '/a', connectedAt: 0 },
      { id: 'test-b', label: 'two', configDir: '/b', connectedAt: 0 },
    ];
    deps.removeAccount = removeAccount;
    const connect = new AccountsConnect(deps);
    const result = await connect.disconnect('test-b');
    expect(result.ok).toBe(true);
    expect(removeAccount).toHaveBeenCalledWith('test-b');
  });

  it('refuses disconnecting an id that does not exist', async () => {
    const connect = connectWith([
      { id: 'test-a', label: 'one', configDir: '/a', connectedAt: 0 },
      { id: 'test-b', label: 'two', configDir: '/b', connectedAt: 0 },
    ]);
    const result = await connect.disconnect('nope');
    expect(result.ok).toBe(false);
  });

  it('re-evaluates the sole-remaining check on every call, not a cached snapshot', async () => {
    // A three-account scenario: disconnecting down to one, one at a time, must refuse
    // exactly once -- on the last account -- never earlier from a stale count and never
    // later by having missed that it became the last one.
    let accounts: AccountRecord[] = [
      { id: 'test-a', label: 'a', configDir: '/a', connectedAt: 0 },
      { id: 'test-b', label: 'b', configDir: '/b', connectedAt: 0 },
      { id: 'test-c', label: 'c', configDir: '/c', connectedAt: 0 },
    ];
    const { deps } = makeDeps();
    deps.loadAccounts = () => accounts;
    deps.removeAccount = (id: string) => { accounts = accounts.filter((a) => a.id !== id); };
    const connect = new AccountsConnect(deps);

    const first = await connect.disconnect('test-a');
    expect(first.ok).toBe(true);
    expect(accounts).toHaveLength(2);

    const second = await connect.disconnect('test-b');
    expect(second.ok).toBe(true);
    expect(accounts).toHaveLength(1);

    const third = await connect.disconnect('test-c');
    expect(third.ok).toBe(false);
    expect(accounts).toHaveLength(1);
  });

  it('logs the account out before removing it from the registry', async () => {
    const order: string[] = [];
    const removeAccount = vi.fn(() => { order.push('removeAccount'); });
    const logout = vi.fn(async (_configDir: string) => { order.push('logout'); return { ok: true }; });
    const { deps } = makeDeps();
    deps.loadAccounts = () => [
      { id: 'test-a', label: 'one', configDir: '/a', connectedAt: 0 },
      { id: 'test-b', label: 'two', configDir: '/b', connectedAt: 0 },
    ];
    deps.removeAccount = removeAccount;
    deps.logout = logout;
    const connect = new AccountsConnect(deps);
    const result = await connect.disconnect('test-b');
    expect(result.ok).toBe(true);
    expect(logout).toHaveBeenCalledWith('/b');
    expect(order).toEqual(['logout', 'removeAccount']);
  });

  it('refuses to remove the registry row when logout fails, leaving the account intact', async () => {
    const removeAccount = vi.fn();
    const { deps } = makeDeps();
    deps.loadAccounts = () => [
      { id: 'test-a', label: 'one', configDir: '/a', connectedAt: 0 },
      { id: 'test-b', label: 'two', configDir: '/b', connectedAt: 0 },
    ];
    deps.removeAccount = removeAccount;
    deps.logout = vi.fn(async () => ({ ok: false, error: 'claude auth logout exited 1' }));
    const connect = new AccountsConnect(deps);
    const result = await connect.disconnect('test-b');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/logout/i);
    expect(removeAccount).not.toHaveBeenCalled();
  });
});
