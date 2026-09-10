/**
 * Picking an account by how much room it actually has left.
 *
 * Three defects this covers, all measured on this machine on 2026-09-10:
 *
 * - the registry refused the only other real subscription by name, because its config
 *   dir was the operator's own, while happily holding the SAME subscription twice under
 *   two different directories. The directory was never the thing worth deduping.
 * - a model-scoped weekly bucket (`weekly:Fable` at 87%) counted against a Sonnet run
 *   that bucket could not stop.
 * - an account nobody had ever read counted as fully free, so a fresh login was tried
 *   ahead of a measured one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkAddCandidate, pickAccount, validateAccounts, type AccountRecord,
} from '../../src/forge/accounts.js';
import { recordReading, usedFraction, type AccountUsage } from '../../src/forge/accounts-usage.js';
import { readAccountUsage } from '../../src/forge/accounts-usage.js';

let dir: string;
let usagePath: string;
const NOW = Date.parse('2026-09-10T12:00:00Z');
const LATER = NOW + 3_600_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-headroom-'));
  usagePath = join(dir, 'usage.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function account(id: string, extra: Partial<AccountRecord> = {}): AccountRecord {
  return { id, provider: 'claude', label: id, configDir: join(dir, id), connectedAt: NOW, ...extra };
}

describe('no directory is privileged', () => {
  it('accepts the operator\'s own config dir as an ordinary account', () => {
    const own = join(homedir(), '.claude');
    const verdict = validateAccounts([account('b', { configDir: own })]);
    expect(verdict).toEqual({ ok: true });
  });

  it('still refuses two accounts sharing one config dir', () => {
    const verdict = validateAccounts([
      account('a', { configDir: join(dir, 'same') }),
      account('b', { configDir: join(dir, 'same') }),
    ]);
    expect(verdict.ok).toBe(false);
  });
});

describe('one subscription is one row, whatever directory it is behind', () => {
  it('refuses a candidate whose accountUuid already belongs to another row, naming that row', () => {
    const existing = [account('fleet', { accountUuid: 'uuid-A' })];
    const verdict = checkAddCandidate(existing, {
      id: 'fleet-again', configDir: join(dir, 'other-dir'), accountUuid: 'uuid-A',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/fleet/);
  });

  it('accepts a second directory that is a genuinely different subscription', () => {
    const existing = [account('fleet', { accountUuid: 'uuid-A' })];
    const verdict = checkAddCandidate(existing, {
      id: 'interactive', configDir: join(dir, 'other-dir'), accountUuid: 'uuid-B',
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('does not dedupe rows that have no accountUuid yet', () => {
    const verdict = validateAccounts([account('a'), account('b')]);
    expect(verdict).toEqual({ ok: true });
  });
});

describe('a window only counts when it can stop the run', () => {
  beforeEach(() => {
    recordReading('a', {
      at: NOW,
      windows: [
        { key: 'session', label: 'Session', usedPct: 10, resetsAt: LATER },
        { key: 'weekly', label: 'Weekly', usedPct: 20, resetsAt: LATER },
        { key: 'weekly:Fable', label: 'Weekly · Fable', usedPct: 100, resetsAt: LATER },
      ],
    }, usagePath);
  });

  it('ignores a full model-scoped window for a run on another model', () => {
    const usage = readAccountUsage(usagePath);
    expect(usedFraction('a', NOW, usage, 'sonnet')).toBeCloseTo(0.2);
  });

  it('binds on the model-scoped window for a run on that model', () => {
    const usage = readAccountUsage(usagePath);
    expect(usedFraction('a', NOW, usage, 'fable')).toBeCloseTo(1);
  });

  it('with no model named, keeps the old worst-of-every-window answer', () => {
    const usage = readAccountUsage(usagePath);
    expect(usedFraction('a', NOW, usage)).toBeCloseTo(1);
  });

  it('picks the account with room for THIS model, not the one with the best headline', () => {
    recordReading('b', {
      at: NOW,
      windows: [
        { key: 'session', label: 'Session', usedPct: 30, resetsAt: LATER },
        { key: 'weekly', label: 'Weekly', usedPct: 30, resetsAt: LATER },
      ],
    }, usagePath);
    const usage = readAccountUsage(usagePath);
    const accounts = [account('a'), account('b')];
    expect(pickAccount(accounts, usage, {}, NOW, 'claude', 'fable')?.id).toBe('b');
    expect(pickAccount(accounts, usage, {}, NOW, 'claude', 'sonnet')?.id).toBe('a');
  });
});

describe('an unmeasured account is not a free one', () => {
  it('prefers a measured busy account over one nobody has ever read', () => {
    recordReading('measured', {
      at: NOW,
      windows: [{ key: 'weekly', label: 'Weekly', usedPct: 90, resetsAt: LATER }],
    }, usagePath);
    const usage: AccountUsage = readAccountUsage(usagePath);
    const picked = pickAccount([account('measured'), account('never-read')], usage, {}, NOW);
    expect(picked?.id).toBe('measured');
  });

  it('still picks an unmeasured account when it is the only one left', () => {
    const picked = pickAccount([account('never-read')], {}, {}, NOW);
    expect(picked?.id).toBe('never-read');
  });
});
