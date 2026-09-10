/**
 * What a launch does when no account of its provider is usable.
 *
 * Before this, `forge run` took `pickWithRefresh`'s `undefined` and launched under the
 * machine's own login anyway -- so a fleet with every window spent quietly spent the
 * window the operator was working in, which is the exact outcome `lastResort` exists to
 * prevent. The rule now has two halves, and the second one is the regression this file
 * guards: a registry with rows in it refuses, and an EMPTY registry still falls through,
 * because that fallback is what makes a fresh install work at all.
 *
 * In-memory usage store, no disk and no network, the same shape
 * `accounts-service.test.ts` already uses.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AccountsService, launchAccountDecision, type AccountsServiceDeps,
} from '../../src/forge/accounts-service.js';
import type { AccountRecord } from '../../src/forge/accounts.js';
import type { AccountUsage } from '../../src/forge/accounts-usage.js';
import type { UsageReading } from '../../src/forge/accounts-probe.js';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const RESET_EARLY = Date.parse('2026-09-10T15:00:00Z');
const RESET_LATE = Date.parse('2026-09-10T19:00:00Z');

function account(id: string, extra: Partial<AccountRecord> = {}): AccountRecord {
  return { id, provider: 'claude', label: id, configDir: `/accounts/${id}`, connectedAt: NOW, ...extra };
}

function spent(at: number, resetsAt: number): AccountUsage[string] {
  return { reading: { at, windows: [{ key: 'session', label: 'Session', usedPct: 100, resetsAt }] } };
}

function makeDeps(overrides: Partial<AccountsServiceDeps> = {}): AccountsServiceDeps {
  return {
    loadAccounts: () => [],
    readUsage: () => ({}),
    recordReading: () => {},
    recordReadError: () => {},
    liveRuns: () => ({}),
    fleetConfigDir: () => '/fleet/config',
    probe: vi.fn(async () => ({ windows: [] }) as UsageReading),
    now: () => NOW,
    ...overrides,
  };
}

describe('exhaustion()', () => {
  it('reports nothing registered when the registry holds no row of that provider', () => {
    const service = new AccountsService(makeDeps());
    expect(service.exhaustion('claude')).toEqual({ registered: false, earliestReset: null });
  });

  it('does not count another provider as registered', () => {
    const codex = account('cx', { provider: 'codex' });
    const service = new AccountsService(makeDeps({ loadAccounts: () => [codex] }));
    expect(service.exhaustion('claude').registered).toBe(false);
    expect(service.exhaustion('codex').registered).toBe(true);
  });

  it('takes the earliest reset across every row of the provider', () => {
    const service = new AccountsService(makeDeps({
      loadAccounts: () => [account('a'), account('b')],
      readUsage: () => ({ a: spent(NOW, RESET_LATE), b: spent(NOW, RESET_EARLY) }),
    }));
    expect(service.exhaustion('claude')).toEqual({ registered: true, earliestReset: RESET_EARLY });
  });

  it('reports a null reset when the provider gave no reset time', () => {
    const service = new AccountsService(makeDeps({
      loadAccounts: () => [account('a')],
      readUsage: () => ({ a: { reading: { at: NOW, windows: [{ key: 'session', label: 'Session', usedPct: 100, resetsAt: null }] } } }),
    }));
    expect(service.exhaustion('claude')).toEqual({ registered: true, earliestReset: null });
  });

  it('ignores a reset that has already passed', () => {
    const past = NOW - 60_000;
    const service = new AccountsService(makeDeps({
      loadAccounts: () => [account('a')],
      readUsage: () => ({ a: spent(NOW, past) }),
    }));
    expect(service.exhaustion('claude').earliestReset).toBeNull();
  });
});

describe('launchAccountDecision()', () => {
  const picked = account('a');

  it('launches under the picked account', () => {
    const decision = launchAccountDecision(picked, { registered: true, earliestReset: RESET_EARLY }, NOW);
    expect(decision.refused).toBe(false);
    expect(decision.refused === false && decision.account?.id).toBe('a');
  });

  it('falls through to the machine login when the registry is EMPTY', () => {
    const decision = launchAccountDecision(undefined, { registered: false, earliestReset: null }, NOW);
    expect(decision.refused).toBe(false);
    expect(decision.refused === false && decision.account).toBeUndefined();
  });

  it('refuses when rows are registered and none is usable', () => {
    const decision = launchAccountDecision(undefined, { registered: true, earliestReset: RESET_EARLY }, NOW);
    expect(decision.refused).toBe(true);
    expect(decision.refused === true && decision.reason).toContain('3h');
  });

  it('refuses without a reset time when the provider gave none', () => {
    const decision = launchAccountDecision(undefined, { registered: true, earliestReset: null }, NOW);
    expect(decision.refused).toBe(true);
    expect(decision.refused === true && decision.reason).toContain('no reset time');
  });
});

describe('an exhausted Claude fleet never reaches a Codex account', () => {
  it('refuses rather than picking a healthy codex row', async () => {
    const claude = account('a');
    const codex = account('cx', { provider: 'codex' });
    const service = new AccountsService(makeDeps({
      loadAccounts: () => [claude, codex],
      readUsage: () => ({ a: spent(NOW, RESET_EARLY) }),
      staleMs: Number.MAX_SAFE_INTEGER,
    }));

    const chosen = await service.pickWithRefresh('claude');
    expect(chosen).toBeUndefined();

    const decision = launchAccountDecision(chosen, service.exhaustion('claude'), NOW);
    expect(decision.refused).toBe(true);
    // The codex row is registered and healthy, and it is still not what a claude launch
    // gets handed. Nothing here may ever return `cx`.
    expect(JSON.stringify(decision)).not.toContain('cx');
  });
});
