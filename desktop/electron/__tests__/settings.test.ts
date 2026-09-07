import { describe, it, expect } from 'vitest';
import {
  mergeForgeEnv, readSettings, updateSettings, writeSettings, type SettingsFs,
} from '../settings';

function memoryFs(initial: Record<string, string> = {}): SettingsFs & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p, data) => {
      files[p] = data;
    },
    mkdirSync: () => {},
  };
}

describe('readSettings', () => {
  it('returns an empty object when the file does not exist', () => {
    const fs = memoryFs();
    expect(readSettings(fs, '/settings.json')).toEqual({});
  });

  it('returns an empty object when the file is corrupt, rather than throwing', () => {
    const fs = memoryFs({ '/settings.json': '{not json' });
    expect(readSettings(fs, '/settings.json')).toEqual({});
  });

  it('reads back what was written', () => {
    const fs = memoryFs({ '/settings.json': JSON.stringify({ checkoutDir: '/repo' }) });
    expect(readSettings(fs, '/settings.json')).toEqual({ checkoutDir: '/repo' });
  });
});

describe('writeSettings and updateSettings', () => {
  it('writes exactly what is given', () => {
    const fs = memoryFs();
    writeSettings(fs, '/dir/settings.json', { checkoutDir: '/repo' });
    expect(JSON.parse(fs.files['/dir/settings.json']!)).toEqual({ checkoutDir: '/repo' });
  });

  it('merges a patch onto whatever was already there', () => {
    const fs = memoryFs({ '/settings.json': JSON.stringify({ checkoutDir: '/repo' }) });
    const result = updateSettings(fs, '/settings.json', { windowBounds: { width: 1200, height: 800 } });
    expect(result).toEqual({ checkoutDir: '/repo', windowBounds: { width: 1200, height: 800 } });
    expect(JSON.parse(fs.files['/settings.json']!)).toEqual(result);
  });

  it('a later patch overwrites the same key rather than merging it deeply', () => {
    const fs = memoryFs({ '/settings.json': JSON.stringify({ checkoutDir: '/old' }) });
    const result = updateSettings(fs, '/settings.json', { checkoutDir: '/new' });
    expect(result.checkoutDir).toBe('/new');
  });

  // C.3: forgeEnv is a plain string map, same as every other setting -- round-trips
  // through the same read/write path with no special handling of its own.
  it('round-trips forgeEnv like any other setting', () => {
    const fs = memoryFs();
    updateSettings(fs, '/settings.json', { forgeEnv: { FORGE_QUEUE: '1', FORGE_PORT: '4130' } });
    expect(readSettings(fs, '/settings.json').forgeEnv).toEqual({ FORGE_QUEUE: '1', FORGE_PORT: '4130' });
  });
});

// C.3: the settings panel's forgeEnv merged into the spawned console's env at launch, in
// `main.ts` at the same spot `FORGE_REPO_DIR` is set for `resolveCheckoutDir`.
describe('mergeForgeEnv', () => {
  it('adds a key the base process env never had', () => {
    expect(mergeForgeEnv({ PATH: '/bin' }, { FORGE_QUEUE: '1' })).toEqual({ PATH: '/bin', FORGE_QUEUE: '1' });
  });

  it('a setting overrides a value already in the base env', () => {
    expect(mergeForgeEnv({ FORGE_QUEUE: '0' }, { FORGE_QUEUE: '1' })).toEqual({ FORGE_QUEUE: '1' });
  });

  it('an empty or missing forgeEnv leaves the base env untouched', () => {
    const base = { FORGE_QUEUE: '1' };
    expect(mergeForgeEnv(base, undefined)).toEqual(base);
    expect(mergeForgeEnv(base, {})).toEqual(base);
  });

  it('never mutates the base env object it is given', () => {
    const base = { FORGE_QUEUE: '0' };
    mergeForgeEnv(base, { FORGE_QUEUE: '1' });
    expect(base['FORGE_QUEUE']).toBe('0');
  });
});
