import { describe, it, expect } from 'vitest';
import { readCheckoutFile, type CheckoutFileFs } from '../checkout-file';
import { locateCheckout, type LocateFs } from '../locate-checkout';

const join = (...parts: string[]) => parts.join('/');

describe('readCheckoutFile', () => {
  it('reads the trimmed content of ~/.forge/console.checkout', () => {
    const fs: CheckoutFileFs = {
      existsSync: (p) => p === '/h/.forge/console.checkout',
      readFileSync: () => 'D:/repos/console-checkout\r\n',
    };
    expect(readCheckoutFile(fs, join, '/h')).toBe('D:/repos/console-checkout');
  });

  it('is undefined when the file does not exist', () => {
    const fs: CheckoutFileFs = { existsSync: () => false, readFileSync: () => '' };
    expect(readCheckoutFile(fs, join, '/h')).toBeUndefined();
  });

  it('is undefined for an empty file', () => {
    const fs: CheckoutFileFs = { existsSync: () => true, readFileSync: () => '   \r\n' };
    expect(readCheckoutFile(fs, join, '/h')).toBeUndefined();
  });
});

describe('locateCheckout: the console.checkout fixture wins over the install dir', () => {
  it('the checkout-file candidate wins over installDir when both check out', () => {
    const fs: LocateFs = {
      existsSync: (p) => p === '/from-file/package.json' || p === '/from-file/dist/forge/cli.js'
        || p === '/install/package.json' || p === '/install/dist/forge/cli.js',
    };
    const result = locateCheckout(fs, {
      env: {},
      checkoutFileDir: '/from-file',
      installDir: '/install',
      join,
    });
    expect(result).toEqual({ kind: 'ok', dir: '/from-file', source: 'checkout-file' });
  });

  // Was "FORGE_REPO_DIR still wins over the checkout-file candidate". Ranking one
  // configured setting above another is the silent choice removed on 2026-09-11: two
  // settings naming different trees now refuse and name both.
  it('two configured settings naming different trees refuse instead of ranking', () => {
    const fs: LocateFs = {
      existsSync: (p) => p === '/env/package.json' || p === '/env/dist/forge/cli.js'
        || p === '/from-file/package.json' || p === '/from-file/dist/forge/cli.js',
    };
    const result = locateCheckout(fs, {
      env: { FORGE_REPO_DIR: '/env' },
      checkoutFileDir: '/from-file',
      join,
    });
    expect(result.kind).toBe('refused');
    const why = result.kind === 'refused' ? result.refusal : '';
    expect(why).toContain('/env');
    expect(why).toContain('/from-file');
  });

  // Was "falls through to the install dir when the checkout-file candidate does not
  // check out". A configured setting pointing at a non-checkout is now a refusal, not a
  // reason to run the install dir instead.
  it('refuses when the checkout-file candidate does not check out, rather than using the install dir', () => {
    const fs: LocateFs = {
      existsSync: (p) => p === '/install/package.json' || p === '/install/dist/forge/cli.js',
    };
    const result = locateCheckout(fs, {
      env: {},
      checkoutFileDir: '/not-a-repo',
      installDir: '/install',
      join,
    });
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' && result.refusal.includes('/not-a-repo')).toBe(true);
  });
});
