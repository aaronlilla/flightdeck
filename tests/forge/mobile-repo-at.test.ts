/**
 * Item 16 follow-up, 2026-09-12: which repos get a ship prediction.
 *
 * Three rounds got this wrong in three ways. Reading the permissive repo kind put an
 * Android and iOS ship path on every Node repo. Reading the declared kind turned the
 * feature off, since nothing sets it. Then taking a `frontend` declaration as proof of
 * a mobile build re-entered the first defect through the declaration branch: `frontend`
 * means only "not backend", and it is what picks the terminal state in the hand-off.
 *
 * Only the checkout decides, with one veto: a declared backend is never readied.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readChainEnv } from '../../src/forge/chain-env.js';
import { mobileRepoAt } from '../../src/forge/queue-wire.js';

function checkout(dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mobile-repo-'));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

describe('mobileRepoAt', () => {
  it('says yes to a checkout with an android directory', () => {
    const env = readChainEnv({ FORGE_REPO_CHECKOUTS: `o/app=${checkout(['android'])}` });
    expect(mobileRepoAt(env, 'o/app')).toBe(true);
  });

  it('says yes to a checkout with an ios directory', () => {
    const env = readChainEnv({ FORGE_REPO_CHECKOUTS: `o/app=${checkout(['ios'])}` });
    expect(mobileRepoAt(env, 'o/app')).toBe(true);
  });

  it('says no to a checkout with neither, however it is declared', () => {
    const path = checkout(['src']);
    const env = readChainEnv({
      FORGE_REPO_CHECKOUTS: `o/web=${path}`,
      FORGE_REPO_KIND: 'o/web=frontend',
    });
    expect(mobileRepoAt(env, 'o/web')).toBe(false);
  });

  // The veto: a backend repo stops at draft-pr-open by design, and its owner is pinged
  // on the assumption the pull request is still a draft.
  it('says no to a declared backend even when its checkout has a mobile directory', () => {
    const path = checkout(['android']);
    const env = readChainEnv({
      FORGE_REPO_CHECKOUTS: `o/api=${path}`,
      FORGE_REPO_KIND: 'o/api=backend',
    });
    expect(mobileRepoAt(env, 'o/api')).toBe(false);
  });

  it('says no when no checkout is configured for the repo', () => {
    expect(mobileRepoAt(readChainEnv({}), 'o/app')).toBe(false);
  });

  it('says no with no environment at all', () => {
    expect(mobileRepoAt(undefined, 'o/app')).toBe(false);
  });
});
