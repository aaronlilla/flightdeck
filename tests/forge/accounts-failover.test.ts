/**
 * Account failover: the console can add a second Claude account, and a session picks
 * one that is not rate-limited.
 *
 * The bug this closes: `WindowGate` held rate-limit pauses in memory and every launch
 * built a fresh one, so a limit one process hit was invisible to the next process's
 * choice of account. The Conductor never consulted the registry at all -- it always
 * used the fleet login -- so connecting an account could not help it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addAccount, configDirForSession, loadAccounts, pickAccount, type AccountRecord } from '../../src/forge/accounts.js';
import { isLimited, limitedUntil, readAccountUsage, recordPlan, recordRateLimit } from '../../src/forge/accounts-usage.js';
import { planFrom } from '../../src/forge/accounts-connect.js';
import { fleetConfigDir } from '../../src/forge/paths.js';

let dir: string;
let usagePath: string;
let registryPath: string;
const NOW = Date.parse('2026-09-09T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-failover-'));
  usagePath = join(dir, 'usage.json');
  registryPath = join(dir, 'registry.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function account(id: string, extra: Partial<AccountRecord> = {}): AccountRecord {
  return { id, label: id, configDir: join(dir, id), connectedAt: NOW, ...extra };
}

describe('the usage store remembers a limit across processes', () => {
  it('records a limit, reads it back, and forgets it once it has lifted', () => {
    expect(readAccountUsage(usagePath)).toEqual({});
    recordRateLimit('a', 'five_hour', NOW + 60_000, NOW, usagePath);

    // A second reader is a stand-in for the next process: it reads from disk, which is
    // exactly what WindowGate could not do.
    const usage = readAccountUsage(usagePath);
    expect(isLimited('a', NOW, usage)).toBe(true);
    expect(limitedUntil('a', NOW, usage)).toEqual({ until: NOW + 60_000, window: 'five_hour' });

    expect(isLimited('a', NOW + 61_000, usage)).toBe(false);
    expect(limitedUntil('a', NOW + 61_000, usage)).toBeNull();
  });

  it('keeps the later of two windows and leaves an unknown account unlimited', () => {
    recordRateLimit('a', 'five_hour', NOW + 60_000, NOW, usagePath);
    recordRateLimit('a', 'seven_day', NOW + 600_000, NOW, usagePath);
    const usage = readAccountUsage(usagePath);
    expect(limitedUntil('a', NOW, usage)).toEqual({ until: NOW + 600_000, window: 'seven_day' });
    expect(isLimited('never-seen', NOW, usage)).toBe(false);
  });

  it('records the plan a probe reported without disturbing the limit', () => {
    recordRateLimit('a', 'five_hour', NOW + 60_000, NOW, usagePath);
    recordPlan('a', 'max', NOW, usagePath);
    const usage = readAccountUsage(usagePath);
    expect(usage['a']?.plan).toBe('max');
    expect(isLimited('a', NOW, usage)).toBe(true);
  });

  it('reads a torn file as empty rather than throwing', () => {
    writeFileSync(usagePath, '{"a": {"windows"', 'utf8');
    expect(readAccountUsage(usagePath)).toEqual({});
  });
});

describe('a session picks an account that is not limited', () => {
  it('skips the limited account and takes the other one', () => {
    recordRateLimit('a', 'five_hour', NOW + 60_000, NOW, usagePath);
    const usage = readAccountUsage(usagePath);
    const picked = pickAccount([account('a'), account('b')], usage, {}, NOW);
    expect(picked?.id).toBe('b');
  });

  it('prefers the least busy account when neither is limited', () => {
    const picked = pickAccount([account('a'), account('b')], {}, { a: 2, b: 0 }, NOW);
    expect(picked?.id).toBe('b');
  });

  it('picks nothing when every account is limited', () => {
    recordRateLimit('a', 'five_hour', NOW + 60_000, NOW, usagePath);
    recordRateLimit('b', 'five_hour', NOW + 60_000, NOW, usagePath);
    expect(pickAccount([account('a'), account('b')], readAccountUsage(usagePath), {}, NOW)).toBeUndefined();
  });

  it('takes the limited account back once its window has passed', () => {
    recordRateLimit('a', 'five_hour', NOW + 60_000, NOW, usagePath);
    const usage = readAccountUsage(usagePath);
    expect(pickAccount([account('a')], usage, {}, NOW)).toBeUndefined();
    expect(pickAccount([account('a')], usage, {}, NOW + 61_000)?.id).toBe('a');
  });
});

describe('the config directory a session authenticates through', () => {
  const fleet = (): boolean => false;

  it('is the picked account when the registry has a usable one', () => {
    const chosen = configDirForSession([account('a')], {}, {}, NOW, fleet);
    expect(chosen).toEqual({ configDir: join(dir, 'a'), accountId: 'a' });
  });

  it('falls back to the fleet login with no accounts at all', () => {
    // Whichever branch `fleetConfigDir` takes on this machine is the right answer; what
    // matters is that no account is claimed and the session still has somewhere to run.
    const chosen = configDirForSession([], {}, {}, NOW, fleet);
    expect(chosen.accountId).toBeNull();
    expect(chosen.configDir).toBe(fleetConfigDir(fleet));
    expect(configDirForSession([], {}, {}, NOW, () => true).configDir).toContain('claude-fleet');
  });

  it('falls back to the fleet login when every account is limited, rather than launching onto a dead one', () => {
    recordRateLimit('a', 'five_hour', NOW + 60_000, NOW, usagePath);
    const chosen = configDirForSession([account('a')], readAccountUsage(usagePath), {}, NOW, fleet);
    expect(chosen.accountId).toBeNull();
  });
});

describe('the registry and the probe', () => {
  it('round-trips an added account', () => {
    addAccount(account('a', { label: 'work' }), registryPath);
    expect(loadAccounts(registryPath).map((row) => row.label)).toEqual(['work']);
    expect(JSON.parse(readFileSync(registryPath, 'utf8')).accounts).toHaveLength(1);
  });

  it('reads the plan out of a real auth status body and nothing out of anything else', () => {
    expect(planFrom('{"loggedIn":true,"email":"x@y.z","subscriptionType":"max"}')).toBe('max');
    expect(planFrom('noise before {"subscriptionType":"pro"} noise after')).toBe('pro');
    expect(planFrom('{"loggedIn":true}')).toBeUndefined();
    expect(planFrom('not json at all')).toBeUndefined();
  });
});
