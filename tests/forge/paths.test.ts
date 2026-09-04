/**
 * Where Forge's worker config directory comes from.
 *
 * A built `forge` defaulted to `~/.forge/claude`, where nothing has ever logged in, even
 * when a dedicated fleet login exists at `~/.forge/fleet-claude`. That candidate is
 * forge-owned rather than `~/.claude-fleet` on purpose: the latter is confirmed live on
 * the machine this shipped from as Aaron's own account-wide Claude Code config directory,
 * not something forge workers may share. The `exists` parameter lets these specimens pin
 * both branches without depending on whether this machine happens to have a real fleet
 * login provisioned.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { fleetConfigDir, fleetConfigDirChoice } from '../../src/forge/paths.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-paths-'));
  process.env['FORGE_HOME'] = home;
  delete process.env['FORGE_CONFIG_DIR'];
});

describe('choosing the worker config directory', () => {
  it('prefers the fleet directory when the injected reader says it exists', () => {
    const choice = fleetConfigDirChoice(() => true);
    expect(choice.source).toBe('fleet');
    expect(choice.dir).toContain(home);
    expect(choice.dir).toContain('fleet-claude');
  });

  it('falls back to the forge directory when the injected reader says the fleet one is absent', () => {
    const choice = fleetConfigDirChoice(() => false);
    expect(choice.source).toBe('forge');
    expect(choice.dir).toContain(home);
    expect(choice.dir).toContain('claude');
  });

  it('an explicit FORGE_CONFIG_DIR wins over both, and the reader is never asked', () => {
    process.env['FORGE_CONFIG_DIR'] = '/pinned/by/hand';
    const choice = fleetConfigDirChoice(() => {
      throw new Error('the override should short-circuit before this runs');
    });
    expect(choice.source).toBe('override');
    expect(choice.dir).toBe('/pinned/by/hand');
  });

  it('fleetConfigDir returns just the chosen path', () => {
    expect(fleetConfigDir(() => true)).toBe(fleetConfigDirChoice(() => true).dir);
    expect(fleetConfigDir(() => false)).toBe(fleetConfigDirChoice(() => false).dir);
  });
});
