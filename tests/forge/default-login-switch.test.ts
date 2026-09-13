import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { defaultLoginOff, setDefaultLoginOff, spendConfigDir } from '../../src/forge/accounts.js';

/**
 * Aaron, 2026-09-12: "i have no way to unlink the other account, which i should be able
 * to." The login he meant is the machine's own, which has no registry row to remove, so
 * its row carried no control at all -- no Unlink, no use controls.
 *
 * The control is a switch instead of a delete: the login stays signed in and is still
 * read for settings and credentials, and what stops is spending its quota. It cannot be
 * switched off while it is the only Claude login the machine has.
 */

const WEEK = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

let dir: string;
let registry: string;
let usage: string;

function writeRegistry(accounts: Array<Record<string, unknown>>): void {
  writeFileSync(registry, JSON.stringify({ accounts }), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'default-login-'));
  registry = join(dir, 'registry.json');
  usage = join(dir, 'usage.json');
  writeFileSync(usage, '{}', 'utf8');
  writeRegistry([
    { id: 'linked', provider: 'claude', email: 'linked@example.com', label: 'linked@example.com', configDir: join(dir, 'config-linked'), connectedAt: 1 },
  ]);
});

describe('switching the machine\'s own login out of the rotation', () => {
  it('is off by default, so a machine that never touched it is unchanged', () => {
    expect(defaultLoginOff(registry)).toBe(false);
  });

  it('is refused while it is the only Claude login there is', () => {
    writeRegistry([]);
    const verdict = setDefaultLoginOff(true, registry);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/link a Claude account first/);
    expect(defaultLoginOff(registry)).toBe(false);
  });

  it('is refused when the only other login is a ChatGPT one, which cannot answer for Claude', () => {
    writeRegistry([
      { id: 'gpt', provider: 'codex', email: 'a@example.com', label: 'a@example.com', configDir: join(dir, 'config-gpt'), connectedAt: 1 },
    ]);
    expect(setDefaultLoginOff(true, registry).ok).toBe(false);
  });

  it('stops a spending path reaching that login once every linked account is spent', () => {
    // Healthy to begin with: the linked account is what gets spent, switch or no switch.
    expect(spendConfigDir(undefined, () => true, NOW, registry, usage))
      .toBe(join(dir, 'config-linked'));

    writeFileSync(usage, JSON.stringify({
      linked: { windows: { week: { limitedUntil: NOW + WEEK, seenAt: NOW } } },
    }), 'utf8');

    // Spent, switch still on: the machine's own login is the fallback, as it always was.
    const fallback = spendConfigDir(undefined, () => true, NOW, registry, usage);
    expect(fallback).not.toBeNull();
    expect(fallback).not.toBe(join(dir, 'config-linked'));

    expect(setDefaultLoginOff(true, registry).ok).toBe(true);
    expect(defaultLoginOff(registry)).toBe(true);

    // Spent, switch off: there is nothing left to spend, and saying so is the point.
    expect(spendConfigDir(undefined, () => true, NOW, registry, usage)).toBeNull();
  });

  it('never hides a login that still has room, however the switch is set', () => {
    expect(setDefaultLoginOff(true, registry).ok).toBe(true);
    expect(spendConfigDir(undefined, () => true, NOW, registry, usage))
      .toBe(join(dir, 'config-linked'));
  });

  it('puts it back', () => {
    expect(setDefaultLoginOff(true, registry).ok).toBe(true);
    expect(setDefaultLoginOff(false, registry).ok).toBe(true);
    expect(defaultLoginOff(registry)).toBe(false);
  });
});
