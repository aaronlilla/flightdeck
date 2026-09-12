/**
 * P5.7: `readChainEnv` and its lookup helpers -- pure parsing, no `process.env` read
 * anywhere else in `chain.ts`/`chain-wire.ts`. Every specimen builds its own env object
 * rather than mutating `process.env`, so nothing here leaks into another test.
 */
import { describe, expect, it } from 'vitest';

import {
  baseFor, branchFor, checkoutFor, hotfixBaseFor, mergeAllowedFor, parseRepoScoped, readChainEnv,
  repoKindFor, verifyCommandFor, worktreePathFor, worktreeSetupFor,
} from '../../../src/forge/chain-env.js';

describe('C1: FORGE_WORKTREE_SHELL', () => {
  it('is empty by default, so the runner falls back to shell: true', () => {
    const env = readChainEnv({});
    expect(env.shell).toEqual([]);
  });

  it('splits into a shell binary plus its flags', () => {
    const env = readChainEnv({ FORGE_WORKTREE_SHELL: '/bin/bash -c' });
    expect(env.shell).toEqual(['/bin/bash', '-c']);
  });
});

describe('readChainEnv', () => {
  it('defaults to disabled, a 300s poll and no repositories configured', () => {
    const env = readChainEnv({});
    expect(env.enabled).toBe(false);
    expect(env.pollSeconds).toBe(300);
    expect(env.checkouts).toEqual([]);
    expect(env.mergeRepos).toEqual([]);
    expect(env.forceCodex).toBe(false);
  });

  it('reads every FORGE_CHAIN_* and FORGE_REPO_* variable', () => {
    const env = readChainEnv({
      FORGE_CHAIN: '1',
      FORGE_CHAIN_POLL_S: '60',
      FORGE_REPO_CHECKOUTS: 'owner/name=D:/repos/name',
      FORGE_REPO_BASE: 'owner/name=main',
      FORGE_WORKTREE_SETUP: 'owner/name=npm ci',
      FORGE_REPO_VERIFY: 'owner/name=npm run verify',
      FORGE_CHAIN_MERGE: 'owner/name,owner/other',
      FORGE_COUNCIL_CODEX: 'always',
    });
    expect(env.enabled).toBe(true);
    expect(env.pollSeconds).toBe(60);
    expect(checkoutFor(env, 'owner/name')).toBe('D:/repos/name');
    expect(baseFor(env, 'owner/name')).toBe('main');
    expect(baseFor(env, 'owner/unset')).toBe('develop');
    expect(worktreeSetupFor(env, 'owner/name')).toBe('npm ci');
    expect(verifyCommandFor(env, 'owner/name')).toBe('npm run verify');
    expect(mergeAllowedFor(env, 'owner/name')).toBe(true);
    expect(mergeAllowedFor(env, 'owner/unlisted')).toBe(false);
    expect(env.forceCodex).toBe(true);
  });

  it('falls back to the 300s default on an unparseable FORGE_CHAIN_POLL_S', () => {
    const env = readChainEnv({ FORGE_CHAIN_POLL_S: 'soon' });
    expect(env.pollSeconds).toBe(300);
  });
});

describe('parseRepoScoped', () => {
  it('splits only on the first "=", so a shell command carrying its own "=" survives', () => {
    const parsed = parseRepoScoped('owner/name=FOO=bar npm run x');
    expect(parsed).toEqual([{ repo: 'owner/name', value: 'FOO=bar npm run x' }]);
  });

  it('throws on a malformed entry rather than silently dropping it', () => {
    expect(() => parseRepoScoped('owner/name')).toThrow(/malformed/);
  });
});

describe('worktreePathFor', () => {
  it('places the worktree in a sibling "worktrees" directory, named <name-lower>--<ticket-lower>', () => {
    const path = worktreePathFor('D:/repos/Name', 'Owner/Name', 'ABC-1');
    expect(path).toBe('D:/repos/worktrees/name--abc-1');
  });
});

describe('branchFor', () => {
  it('lowercases the ticket', () => {
    expect(branchFor('ABC-1')).toBe('feature/abc-1');
  });

  it('A.6: a hotfix-minted ticket branches onto hotfix/<slug>, not feature/<ticket>', () => {
    expect(branchFor('hotfix-null-check-1699999')).toBe('hotfix/null-check-1699999');
  });
});

describe('hotfixBaseFor: A.6', () => {
  it('uses FORGE_HOTFIX_BASE when set', () => {
    const env = readChainEnv({});
    expect(hotfixBaseFor(env, 'owner/name', { FORGE_HOTFIX_BASE: 'develop-hotfix' } as NodeJS.ProcessEnv)).toBe('develop-hotfix');
  });

  it('falls back to the repo\'s ordinary base when unset', () => {
    const env = readChainEnv({ FORGE_REPO_BASE: 'owner/name=main' });
    expect(hotfixBaseFor(env, 'owner/name', {} as NodeJS.ProcessEnv)).toBe('main');
  });
});

describe('repoKindFor: A.4', () => {
  it('reads a repo as backend from FORGE_REPO_KIND', () => {
    const env = readChainEnv({ FORGE_REPO_KIND: 'owner/name=backend' });
    expect(repoKindFor(env, 'owner/name')).toBe('backend');
  });

  it('defaults to frontend when the repo has no entry', () => {
    const env = readChainEnv({});
    expect(repoKindFor(env, 'owner/unset')).toBe('frontend');
  });
});
