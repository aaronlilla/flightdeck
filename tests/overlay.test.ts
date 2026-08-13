import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exemptFragments, loadOverlays, manifestPath } from '../src/overlay/overlays.ts';

let home: string;

function writeManifest(entries: Array<{ name?: string; path?: string }>): void {
  const file = manifestPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ overlays: entries }, null, 2));
}

function makeOverlay(name: string, config?: Record<string, unknown>): string {
  const root = path.join(home, 'overlays', name);
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  if (config) writeFileSync(path.join(root, 'harness.json'), JSON.stringify(config));
  return root;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'flightdeck-overlay-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('overlays', () => {
  it('finds nothing on a machine that has never configured one', () => {
    const load = loadOverlays(home);
    expect(load.manifestFound).toBe(false);
    expect(load.overlays).toEqual([]);
    expect(load.problems).toEqual([]);
  });

  it('picks up the conventional layout with no declaration at all', () => {
    const root = makeOverlay('work');
    writeManifest([{ name: 'work', path: root }]);
    const load = loadOverlays(home);
    expect(load.overlays).toHaveLength(1);
    expect(load.overlays[0]?.skillDirs).toEqual([path.join(root, 'skills')]);
  });

  it('reads authorship exemptions an overlay declares', () => {
    const root = makeOverlay('work', { authorship_exempt: ['/Some-Vault/docs/'] });
    writeManifest([{ name: 'work', path: root }]);
    const load = loadOverlays(home);
    expect(exemptFragments(load)).toEqual(['/some-vault/docs/']);
  });

  it('reports an overlay whose directory is gone instead of failing silently', () => {
    writeManifest([{ name: 'work', path: path.join(home, 'not-here') }]);
    const load = loadOverlays(home);
    expect(load.overlays).toEqual([]);
    expect(load.problems[0]).toContain('nothing at');
  });

  it('reports a manifest that is not valid JSON', () => {
    const file = manifestPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const load = loadOverlays(home);
    expect(load.problems[0]).toContain('not readable JSON');
  });

  it('skips an entry with no path but keeps the others', () => {
    const root = makeOverlay('work');
    writeManifest([{ name: 'broken' }, { name: 'work', path: root }]);
    const load = loadOverlays(home);
    expect(load.overlays.map((o) => o.name)).toEqual(['work']);
    expect(load.problems[0]).toContain('no path');
  });
});
