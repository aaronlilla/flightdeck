/**
 * Where Forge's worker config directory comes from.
 *
 * A built `forge` defaulted to `~/.forge/claude`, where nothing has ever logged in, even
 * when `~/.claude-fleet` -- the account every worker already launches with -- sat one
 * directory over. An earlier version of this function preferred a forge-owned
 * `~/.forge/fleet-claude` over `~/.claude-fleet` on the wrong premise that the latter was
 * Aaron's own interactive directory (it is `~/.claude`); B.3.9 corrects the choice. The
 * `exists` parameter lets these specimens pin both branches without depending on whether
 * this machine happens to have a real fleet login provisioned.
 */
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  it('B.3.9: prefers ~/.claude-fleet when the injected reader says it exists', () => {
    const fleetDir = join(homedir(), '.claude-fleet');
    const choice = fleetConfigDirChoice((path) => path === fleetDir);
    expect(choice.source).toBe('fleet');
    expect(choice.dir).toBe(fleetDir);
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
