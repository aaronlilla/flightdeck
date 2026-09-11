import { describe, it, expect } from 'vitest';
import { checkoutPrompt, locateCheckout, looksLikeForgeRepo, type LocateFs } from '../locate-checkout';

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
  it('uses FORGE_REPO_DIR when it is the only thing configured, and says so', () => {
    const fs = fsWith(new Set(['/env/package.json', '/env/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/env' },
      installDir: '/install',
      join,
    });
    expect(result).toEqual({ kind: 'ok', dir: '/env', source: 'env' });
  });

  // Was "falls through to the remembered path when FORGE_REPO_DIR does not check out".
  // The fall-through is the behaviour Aaron rejected on 2026-09-11, so the same case now
  // asserts the refusal that replaced it. Kept as a case, not deleted.
  it('refuses rather than falling through when FORGE_REPO_DIR does not check out', () => {
    const fs = fsWith(new Set(['/remembered/package.json', '/remembered/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/env' },
      rememberedCheckoutDir: '/remembered',
      installDir: '/install',
      join,
    });
    expect(result.kind).toBe('refused');
  });

  it('uses the install directory when nothing at all is configured', () => {
    const fs = fsWith(new Set(['/install/package.json', '/install/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: {},
      installDir: '/install',
      join,
    });
    expect(result).toEqual({ kind: 'ok', dir: '/install', source: 'install-dir' });
  });

  it('reports nothing configured when nothing checks out', () => {
    const fs = fsWith(new Set());
    const result = locateCheckout(fs, { env: {}, join });
    expect(result).toEqual({ kind: 'unconfigured' });
  });

  // Was "never trusts an env var pointing at a directory with no package.json", which
  // asserted it silently used the remembered one instead. It still never trusts it -- it
  // now refuses instead of substituting a directory nobody chose for this run.
  it('never trusts an env var pointing at a directory with no package.json', () => {
    const fs = fsWith(new Set(['/remembered/package.json', '/remembered/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/not-a-repo' },
      rememberedCheckoutDir: '/remembered',
      join,
    });
    expect(result.kind).toBe('refused');
    expect(result.kind === 'ok' ? result.dir : undefined).toBeUndefined();
  });
});

/**
 * "I don't want the console to ever fallback, why would I want that" (Aaron,
 * 2026-09-11). Falling back means quietly running a directory the operator did not
 * choose. Two shapes of that, both of which used to resolve silently.
 */
describe('locateCheckout never silently runs a directory nobody chose', () => {
  it('refuses when a configured candidate is present but is not a checkout, instead of taking the next one', () => {
    const fs = fsWith(new Set(['/remembered/package.json', '/remembered/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/not-a-repo' },
      rememberedCheckoutDir: '/remembered',
      join,
    });
    expect(result.kind).toBe('refused');
    expect(result.kind === 'ok' ? result.dir : undefined).toBeUndefined();
  });

  it('names what it looked for and where, in the refusal', () => {
    const fs = fsWith(new Set(['/remembered/package.json', '/remembered/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/not-a-repo' },
      rememberedCheckoutDir: '/remembered',
      join,
    });
    const why = result.kind === 'refused' ? result.refusal : '';
    expect(why).toContain('/not-a-repo');
    expect(why).toContain('FORGE_REPO_DIR');
  });

  it('refuses when two configured candidates disagree, naming both', () => {
    const fs = fsWith(new Set([
      '/env/package.json', '/env/dist/forge/cli.js',
      '/file/package.json', '/file/dist/forge/cli.js',
    ]));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/env' },
      checkoutFileDir: '/file',
      join,
    });
    expect(result.kind).toBe('refused');
    const why = result.kind === 'refused' ? result.refusal : '';
    expect(why).toContain('/env');
    expect(why).toContain('/file');
  });

  it('resolves when every configured candidate agrees, reporting the directory and the source', () => {
    const fs = fsWith(new Set(['/repo/package.json', '/repo/dist/forge/cli.js']));
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/repo' },
      checkoutFileDir: '/repo',
      rememberedCheckoutDir: '/repo',
      join,
    });
    expect(result).toMatchObject({ kind: 'ok', dir: '/repo', source: 'env' });
  });

  it('reports nothing configured as its own outcome, so the caller can still ask for a folder', () => {
    const fs = fsWith(new Set());
    expect(locateCheckout(fs, { env: {}, join }).kind).toBe('unconfigured');
  });
});

/**
 * Refusing to guess must never become an app that cannot start. The first cut of the
 * refusal returned with no picker offered, while the page still said "or pick a folder
 * above" and no folder button was shown -- a dead end whose only exit was editing
 * machine state by hand.
 */
describe('checkoutPrompt', () => {
  it('offers the folder picker on a refusal, and carries the refusal as the status', () => {
    const prompt = checkoutPrompt({ kind: 'refused', refusal: 'they disagree' });
    expect(prompt.pickFolder).toBe(true);
    expect(prompt.status).toBe('they disagree');
    expect(prompt.dir).toBeUndefined();
  });

  it('offers the picker when nothing is configured', () => {
    expect(checkoutPrompt({ kind: 'unconfigured' }).pickFolder).toBe(true);
  });

  it('uses the directory and logs its source when one resolved, without a picker', () => {
    const prompt = checkoutPrompt({ kind: 'ok', dir: '/repo', source: 'checkout-file' });
    expect(prompt).toMatchObject({ dir: '/repo', pickFolder: false });
    expect(prompt.log).toContain('/repo');
    expect(prompt.log).toContain('checkout-file');
  });
});
