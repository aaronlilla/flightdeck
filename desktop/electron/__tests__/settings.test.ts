import { describe, it, expect } from 'vitest';
import { readSettings, writeSettings, updateSettings, type SettingsFs } from '../settings';

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
});
