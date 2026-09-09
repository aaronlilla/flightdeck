/**
 * The Settings page's view of the linked accounts, built against an in-memory usage
 * store and a fake probe -- no disk, no network, no real provider ever touched.
 */
import { describe, expect, it, vi } from 'vitest';

import { AccountsService, FLEET_ACCOUNT_ID, type AccountsServiceDeps } from '../../src/forge/accounts-service.js';
import type { AccountRecord } from '../../src/forge/accounts.js';
import type { AccountUsage } from '../../src/forge/accounts-usage.js';
import type { UsageReading } from '../../src/forge/accounts-probe.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');

function makeStore() {
  let usage: AccountUsage = {};
  return {
    usage: () => usage,
    readUsage: () => usage,
    recordReading: (account: string, reading: UsageReading & { at: number }) => {
      const prev = usage[account] ?? {};
      usage = { ...usage, [account]: { ...prev, readError: undefined, reading } };
    },
    recordReadError: (account: string, error: string, at: number) => {
      usage = { ...usage, [account]: { ...(usage[account] ?? {}), readError: { at, error } } };
    },
  };
}

function makeDeps(overrides: Partial<AccountsServiceDeps> = {}): { deps: AccountsServiceDeps; store: ReturnType<typeof makeStore> } {
  const store = makeStore();
  const deps: AccountsServiceDeps = {
    loadAccounts: () => [],
    readUsage: store.readUsage,
    recordReading: store.recordReading,
    recordReadError: store.recordReadError,
    liveRuns: () => ({}),
    fleetConfigDir: () => '/fleet/config',
    probe: vi.fn(async () => ({ windows: [] }) as UsageReading),
    now: () => NOW,
    ...overrides,
  };
  return { deps, store };
}

function claudeAccount(id: string, extra: Partial<AccountRecord> = {}): AccountRecord {
  return { id, provider: 'claude', label: id, configDir: `/accounts/${id}`, connectedAt: NOW, ...extra };
}

describe('list()', () => {
  it('puts the fleet row first, marked fleet: true', () => {
    const { deps } = makeDeps({ loadAccounts: () => [claudeAccount('a')] });
    const service = new AccountsService(deps);
    const items = service.list();
    expect(items[0]?.id).toBe(FLEET_ACCOUNT_ID);
    expect(items[0]?.fleet).toBe(true);
    expect(items[1]?.id).toBe('a');
  });

  it('has no fleet row when fleetConfigDir() returns null', () => {
    const { deps } = makeDeps({ fleetConfigDir: () => null, loadAccounts: () => [claudeAccount('a')] });
    const service = new AccountsService(deps);
    const items = service.list();
    expect(items.some((item) => item.id === FLEET_ACCOUNT_ID)).toBe(false);
    expect(items.map((i) => i.id)).toEqual(['a']);
  });

  it('triggers exactly one probe for a row with no reading, even across two list() calls before it resolves', async () => {
    let resolveProbe: (reading: UsageReading) => void = () => {};
    const probe = vi.fn(() => new Promise<UsageReading>((resolve) => { resolveProbe = resolve; }));
    const { deps } = makeDeps({ loadAccounts: () => [claudeAccount('a')], probe, fleetConfigDir: () => null });
    const service = new AccountsService(deps);

    service.list();
    service.list();
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe({ windows: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('does not re-probe a fresh reading within staleMs, and does probe once it goes stale', async () => {
    const probe = vi.fn(async () => ({ windows: [] }) as UsageReading);
    let now = NOW;
    const { deps } = makeDeps({ loadAccounts: () => [claudeAccount('a')], probe, now: () => now, staleMs: 1_000, fleetConfigDir: () => null });
    deps.recordReading('a', { at: NOW, windows: [] });

    const service = new AccountsService(deps);
    service.list();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe).not.toHaveBeenCalled();

    now = NOW + 2_000;
    service.list();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a failing probe records readError and keeps the previous windows', async () => {
    const windows = [{ key: 'session', label: 'Session', usedPct: 40, resetsAt: null }];
    const probe = vi.fn(async () => { throw new Error('network blip'); });
    const { deps } = makeDeps({ loadAccounts: () => [claudeAccount('a')], probe, staleMs: 1_000 });
    deps.recordReading('a', { at: NOW - 5_000, windows });

    const service = new AccountsService(deps);
    service.list();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const usage = deps.readUsage();
    expect(usage['a']?.readError?.error).toBe('network blip');
    expect(usage['a']?.reading?.windows).toEqual(windows);
  });

  it('email comes from the account record when present, else from the reading', () => {
    const { deps } = makeDeps({
      loadAccounts: () => [claudeAccount('a', { email: 'record@example.test' }), claudeAccount('b')],
      probe: vi.fn(() => new Promise<UsageReading>(() => {})),
    });
    deps.recordReading('a', { at: NOW, windows: [], email: 'reading-a@example.test' });
    deps.recordReading('b', { at: NOW, windows: [], email: 'reading-b@example.test' });

    const service = new AccountsService(deps);
    const items = service.list();
    expect(items.find((i) => i.id === 'a')?.email).toBe('record@example.test');
    expect(items.find((i) => i.id === 'b')?.email).toBe('reading-b@example.test');
  });

  it('marks the pickAccount winner selected per provider, and the fleet row when no registered claude account wins', () => {
    const { deps } = makeDeps({
      loadAccounts: () => [claudeAccount('a'), claudeAccount('b', { provider: 'codex', label: 'c' })],
      probe: vi.fn(() => new Promise<UsageReading>(() => {})),
    });
    deps.recordReading('a', { at: NOW, windows: [{ key: 'session', label: 'Session', usedPct: 90, resetsAt: null }] });
    // 'a' is the only claude account and is not limited, so it wins claude even though busy.
    const service = new AccountsService(deps);
    const items = service.list();
    expect(items.find((i) => i.id === 'a')?.selected).toBe(true);
    expect(items.find((i) => i.id === FLEET_ACCOUNT_ID)?.selected).toBe(false);
  });

  it('selects the fleet row when there is no registered claude account at all', () => {
    const { deps } = makeDeps({
      loadAccounts: () => [claudeAccount('x', { provider: 'codex' })],
      probe: vi.fn(() => new Promise<UsageReading>(() => {})),
    });
    const service = new AccountsService(deps);
    const items = service.list();
    expect(items.find((i) => i.id === FLEET_ACCOUNT_ID)?.selected).toBe(true);
  });
});
