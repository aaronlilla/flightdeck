import { describe, it, expect } from 'vitest';
import { locateCheckout, looksLikeForgeRepo, type LocateFs } from '../locate-checkout';

function fsWith(existing: Set<string>): LocateFs {
  return { existsSync: (p: string) => existing.has(p) };
}

const join = (...parts: string[]) => parts.join('/');

describe('looksLikeForgeRepo', () => {
  it('is false with no package.json', () => {
    const fs = fsWith(new Set());
    expect(looksLikeForgeRepo(fs, join, '/somewhere')).toBe(false);
  });

  it('is true with package.json and a built entry', () => {
    const fs = fsWith(new Set(['/repo/package.json', '/repo/dist/forge/cli.js']));
    expect(looksLikeForgeRepo(fs, join, '/repo')).toBe(true);
  });

  it('is true with package.json and only a source entry (unbuilt checkout)', () => {
    const fs = fsWith(new Set(['/repo/package.json', '/repo/src/forge/cli.ts']));
    expect(looksLikeForgeRepo(fs, join, '/repo')).toBe(true);
  });

  it('is false with package.json but neither entry (some unrelated project)', () => {
    const fs = fsWith(new Set(['/repo/package.json']));
    expect(looksLikeForgeRepo(fs, join, '/repo')).toBe(false);
  });
});

describe('locateCheckout', () => {
  it('prefers FORGE_REPO_DIR when it checks out', () => {
    const fs = fsWith(new Set(['/env/package.json', '/env/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/env' },
      rememberedCheckoutDir: '/remembered',
      installDir: '/install',
      join,
    });
    expect(result).toEqual({ dir: '/env', source: 'env' });
  });

  it('falls through to the remembered path when FORGE_REPO_DIR does not check out', () => {
    const fs = fsWith(new Set(['/remembered/package.json', '/remembered/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/env' },
      rememberedCheckoutDir: '/remembered',
      installDir: '/install',
      join,
    });
    expect(result).toEqual({ dir: '/remembered', source: 'remembered' });
  });

  it('falls through to the install directory last', () => {
    const fs = fsWith(new Set(['/install/package.json', '/install/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: {},
      rememberedCheckoutDir: '/remembered',
      installDir: '/install',
      join,
    });
    expect(result).toEqual({ dir: '/install', source: 'install-dir' });
  });

  it('returns undefined when nothing checks out', () => {
    const fs = fsWith(new Set());
    const result = locateCheckout(fs, { env: {}, join });
    expect(result).toBeUndefined();
  });

  it('never trusts an env var pointing at a directory with no package.json', () => {
    const fs = fsWith(new Set(['/remembered/package.json', '/remembered/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/not-a-repo' },
      rememberedCheckoutDir: '/remembered',
      join,
    });
    expect(result).toEqual({ dir: '/remembered', source: 'remembered' });
  });
});
