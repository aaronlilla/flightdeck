/**
 * Picking on a reading taken at launch time.
 *
 * Before this, nothing refreshed an account's headroom except the Settings page
 * polling `list()`. With the console shut, every launch chose on whatever numbers were
 * last written -- possibly hours old, possibly never written at all -- and an unread
 * account counted as free. `pickWithRefresh` reads first and picks second, and a probe
 * that fails leaves the previous reading standing rather than reverting to "free".
 */
import { describe, expect, it, vi } from 'vitest';

import { AccountsService, type AccountsServiceDeps } from '../../src/forge/accounts-service.js';
import type { AccountRecord } from '../../src/forge/accounts.js';
import type { AccountUsage } from '../../src/forge/accounts-usage.js';
import type { UsageReading } from '../../src/forge/accounts-probe.js';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const LATER = NOW + 3_600_000;

function makeStore(seed: AccountUsage = {}) {
  let usage: AccountUsage = seed;
  return {
    readUsage: () => usage,
    recordReading: (account: string, reading: UsageReading & { at: number }) => {
      const prev = usage[account] ?? {};
      usage = { ...usage, [account]: { ...prev, readError: undefined, reading } };
    },
    recordReadError: (account: string, error: string, at: number) => {
      usage = { ...usage, [account]: { ...(usage[account] ?? {}), readError: { at, error } } };
    },
    current: () => usage,
  };
}

function account(id: string): AccountRecord {
  return { id, provider: 'claude', label: id, configDir: `/accounts/${id}`, connectedAt: NOW };
}

function deps(store: ReturnType<typeof makeStore>, over: Partial<AccountsServiceDeps> = {}): AccountsServiceDeps {
  return {
    loadAccounts: () => [account('a'), account('b')],
    readUsage: store.readUsage,
    recordReading: store.recordReading,
    recordReadError: store.recordReadError,
    liveRuns: () => ({}),
    fleetConfigDir: () => null,
    probe: vi.fn(async () => ({ windows: [] }) as UsageReading),
    now: () => NOW,
    ...over,
  };
}

function window(key: string, usedPct: number) {
  return { key, label: key, usedPct, resetsAt: LATER };
}

describe('pickWithRefresh', () => {
  it('probes before it picks, so a launch never chooses on numbers nobody refreshed', async () => {
    const store = makeStore();
    const probe = vi.fn(async (_p: unknown, dir: string) => ({
      windows: [window('weekly', dir.endsWith('a') ? 96 : 3)],
    }) as UsageReading);
    const service = new AccountsService(deps(store, { probe }));
    const picked = await service.pickWithRefresh('claude');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(picked?.id).toBe('b');
  });

  it('keeps the previous reading when a probe throws, rather than reading as free', async () => {
    const store = makeStore({
      a: { reading: { at: NOW - 10_000_000, windows: [window('weekly', 96)] } },
      b: { reading: { at: NOW - 10_000_000, windows: [window('weekly', 3)] } },
    });
    const probe = vi.fn(async () => { throw new Error('HTTP 429'); });
    const service = new AccountsService(deps(store, { probe }));
    const picked = await service.pickWithRefresh('claude');
    expect(picked?.id).toBe('b');
    expect(store.current()['a']?.reading?.windows[0]?.usedPct).toBe(96);
    expect(store.current()['a']?.readError?.error).toMatch(/429/);
  });

  it('does not re-probe a reading that is still fresh', async () => {
    const store = makeStore({
      a: { reading: { at: NOW - 1_000, windows: [window('weekly', 96)] } },
      b: { reading: { at: NOW - 1_000, windows: [window('weekly', 3)] } },
    });
    const probe = vi.fn(async () => ({ windows: [] }) as UsageReading);
    const service = new AccountsService(deps(store, { probe }));
    const picked = await service.pickWithRefresh('claude');
    expect(probe).not.toHaveBeenCalled();
    expect(picked?.id).toBe('b');
  });

  it('weighs the model-scoped window of the model it is asked about', async () => {
    const store = makeStore({
      a: { reading: { at: NOW, windows: [window('weekly', 10), window('weekly:Fable', 99)] } },
      b: { reading: { at: NOW, windows: [window('weekly', 50)] } },
    });
    const service = new AccountsService(deps(store));
    expect((await service.pickWithRefresh('claude', 'sonnet'))?.id).toBe('a');
    expect((await service.pickWithRefresh('claude', 'fable'))?.id).toBe('b');
  });
});
