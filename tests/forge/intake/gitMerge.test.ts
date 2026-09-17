/**
 * `gitSquashMergeToBase` (`src/forge/intake/gitMerge.ts`), R-22's git-only replacement for
 * `gh pr merge`. Fake `GitRunFn` specimens prove each failure path aborts cleanly and
 * reports why; the last specimen runs the real function against a real local bare-remote
 * git fixture, with no `gh` anywhere in the picture.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { gitSquashMergeToBase, type GitRunFn } from '../../../src/forge/intake/gitMerge.js';

function fakeGit(script: Record<string, { ok: boolean; stdout?: string }>): { run: GitRunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunFn = async (argv) => {
    calls.push(argv);
    const key = argv[0]!;
    const entry = script[key];
    return { ok: entry?.ok ?? true, stdout: entry?.stdout ?? '' };
  };
  return { run, calls };
}

describe('gitSquashMergeToBase: fake git', () => {
  const input = { checkoutDir: '/tmp/checkout', base: 'develop', branch: 'feature/abc-1', subject: 'Merge feature/abc-1 (#9)', body: '' };

  // Measured 2026-09-12: every Merge on a ticket driven in through the console refused
  // with "could not check out origin/main". The checkout it merges in is a worktree, and
  // the repository's own main checkout already held `main`, so claiming the branch by name
  // failed outright -- "fatal: 'main' is already used by worktree at ...". Detaching never
  // collides, and nothing below the checkout needs the branch name locally.
  it('detaches onto the base rather than claiming the branch another worktree may hold', async () => {
    const { run, calls } = fakeGit({});
    await gitSquashMergeToBase(input, run);
    const checkout = calls.find((argv) => argv[0] === 'checkout');
    expect(checkout, 'it never checked anything out').toBeDefined();
    expect(checkout).toContain('--detach');
    expect(checkout?.at(-1)).toBe('origin/develop');
    expect(checkout, 'it claimed the branch by name').not.toContain('-B');
    // `--force` joined it on 2026-09-13: a modified tracked file left in the merge
    // checkout refused every merge of that repository. See the dirty-checkout specimen.
    expect(checkout, 'a dirty checkout will refuse the merge again').toContain('--force');
  });

  it('still pushes to the base by name, since nothing local carries it now', async () => {
    const { run, calls } = fakeGit({});
    await gitSquashMergeToBase(input, run);
    expect(calls.find((argv) => argv[0] === 'push')).toEqual(['push', 'origin', 'HEAD:develop']);
  });

  it('aborts when fetch fails, without touching the checkout', async () => {
    const { run, calls } = fakeGit({ fetch: { ok: false } });
    const result = await gitSquashMergeToBase(input, run);
    expect(result).toEqual({ ok: false, reason: 'could not fetch origin/develop and origin/feature/abc-1' });
    expect(calls).toEqual([['fetch', 'origin', 'develop', 'feature/abc-1']]);
  });

  it('aborts when the checkout onto origin/base fails', async () => {
    const { run } = fakeGit({ checkout: { ok: false } });
    const result = await gitSquashMergeToBase(input, run);
    expect(result).toEqual({ ok: false, reason: 'could not check out origin/develop' });
  });

  it('aborts the in-progress merge when the squash itself fails', async () => {
    const { run, calls } = fakeGit({ merge: { ok: false } });
    const result = await gitSquashMergeToBase(input, run);
    expect(result).toEqual({ ok: false, reason: 'squash merge of origin/feature/abc-1 onto develop failed' });
    expect(calls).toContainEqual(['merge', '--abort']);
  });

  it('resets the checkout when the commit fails, so nothing is left half-squashed', async () => {
    const { run, calls } = fakeGit({ commit: { ok: false } });
    const result = await gitSquashMergeToBase(input, run);
    expect(result).toEqual({ ok: false, reason: 'commit failed -- nothing to merge, or a pre-commit hook refused it' });
    expect(calls).toContainEqual(['reset', '--hard', 'origin/develop']);
  });

  it('reports a refused push as a likely concurrent merge, and never guesses at a merge sha', async () => {
    const { run } = fakeGit({ push: { ok: false } });
    const result = await gitSquashMergeToBase(input, run);
    expect(result).toEqual({ ok: false, reason: 'push to origin/develop was refused -- a concurrent push likely moved it first' });
  });

  it('returns the pushed commit sha on success', async () => {
    const { run, calls } = fakeGit({ 'rev-parse': { ok: true, stdout: 'abc123def\n' } });
    const result = await gitSquashMergeToBase(input, run);
    expect(result).toEqual({ ok: true, mergeSha: 'abc123def' });
    expect(calls.map((c) => c[0])).toEqual(['fetch', 'checkout', 'merge', 'commit', 'push', 'rev-parse']);
  });

  it('passes both -m flags when a body is given', async () => {
    const { run, calls } = fakeGit({});
    await gitSquashMergeToBase({ ...input, body: 'closes ABC-1' }, run);
    expect(calls).toContainEqual(['commit', '-m', 'Merge feature/abc-1 (#9)', '-m', 'closes ABC-1']);
  });
});

describe('gitSquashMergeToBase: real bare-remote fixture', () => {
  function sh(cwd: string, ...argv: string[]): string {
    return execFileSync('git', argv, { cwd, encoding: 'utf8' });
  }

  const realGit: GitRunFn = (argv, cwd) =>
    new Promise((resolve) => {
      try {
        const stdout = execFileSync('git', argv, { cwd, encoding: 'utf8' });
        resolve({ ok: true, stdout });
      } catch (error) {
        const stdout = error && typeof error === 'object' && 'stdout' in error ? String((error as { stdout: unknown }).stdout ?? '') : '';
        resolve({ ok: false, stdout });
      }
    });

  it('fetches, squashes, commits and pushes a real feature branch onto a real base', { timeout: 20000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitmerge-'));
    const bareDir = join(root, 'origin.git');
    const seedDir = join(root, 'seed');
    const checkoutDir = join(root, 'checkout');

    sh(root, 'init', '--bare', bareDir);
    sh(root, 'clone', bareDir, seedDir);
    sh(seedDir, 'config', 'user.email', 'test@example.com');
    sh(seedDir, 'config', 'user.name', 'Test');
    sh(seedDir, 'commit', '--allow-empty', '-m', 'base commit');
    sh(seedDir, 'branch', '-M', 'develop');
    sh(seedDir, 'push', 'origin', 'develop');
    sh(seedDir, 'checkout', '-b', 'feature/abc-1');
    writeFileSync(join(seedDir, 'feature.txt'), 'feature content\n');
    sh(seedDir, 'add', 'feature.txt');
    sh(seedDir, 'commit', '-m', 'feature commit');
    sh(seedDir, 'push', 'origin', 'feature/abc-1');

    sh(root, 'clone', bareDir, checkoutDir);
    sh(checkoutDir, 'config', 'user.email', 'test@example.com');
    sh(checkoutDir, 'config', 'user.name', 'Test');

    const result = await gitSquashMergeToBase(
      { checkoutDir, base: 'develop', branch: 'feature/abc-1', subject: 'Merge feature/abc-1 (#9)', body: '' },
      realGit,
    );

    expect(result.ok).toBe(true);
    expect(result.mergeSha).toMatch(/^[0-9a-f]{40}$/);

    const log = sh(seedDir, 'fetch', 'origin', 'develop').length >= 0
      ? sh(seedDir, 'log', 'origin/develop', '-1', '--format=%s')
      : '';
    expect(log.trim()).toBe('Merge feature/abc-1 (#9)');
  });

  /**
   * Aaron, 2026-09-13: clicked Merge on a ticket the board called ready, and got back
   * "the merge did not complete: could not check out origin/develop". The checkout this
   * merges in had one uncommitted tracked file -- a `package-lock.json` an install had
   * rewritten -- and git refuses to move HEAD over a modified tracked file. Every merge
   * of that repository refused the same way, and the sentence named the symptom rather
   * than the cause.
   *
   * The checkout exists only to stage merges, so a local edit in it is never work anybody
   * wants: it is what the last install or half-finished merge left. This is the doc
   * comment on the function itself finally being true -- it has always claimed to reset
   * the checkout onto `origin/<base>`, and it only ever detached.
   */
  it('merges even when the checkout was left with a modified tracked file', { timeout: 20000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitmerge-dirty-'));
    const bareDir = join(root, 'origin.git');
    const seedDir = join(root, 'seed');
    const checkoutDir = join(root, 'checkout');

    sh(root, 'init', '--bare', bareDir);
    sh(root, 'clone', bareDir, seedDir);
    sh(seedDir, 'config', 'user.email', 'test@example.com');
    sh(seedDir, 'config', 'user.name', 'Test');
    writeFileSync(join(seedDir, 'package-lock.json'), '{"v":1}' + String.fromCharCode(10));
    sh(seedDir, 'add', 'package-lock.json');
    sh(seedDir, 'commit', '-m', 'base commit');
    sh(seedDir, 'branch', '-M', 'develop');
    sh(seedDir, 'push', 'origin', 'develop');
    sh(seedDir, 'checkout', '-b', 'feature/abc-2');
    writeFileSync(join(seedDir, 'feature.txt'), 'feature content' + String.fromCharCode(10));
    sh(seedDir, 'add', 'feature.txt');
    sh(seedDir, 'commit', '-m', 'feature commit');
    sh(seedDir, 'push', 'origin', 'feature/abc-2');

    sh(root, 'clone', bareDir, checkoutDir);
    sh(checkoutDir, 'config', 'user.email', 'test@example.com');
    sh(checkoutDir, 'config', 'user.name', 'Test');
    // The state the live checkout was in: one tracked file rewritten and never committed.
    writeFileSync(join(checkoutDir, 'package-lock.json'), '{"v":2,"left":"by an install"}' + String.fromCharCode(10));

    const result = await gitSquashMergeToBase(
      { checkoutDir, base: 'develop', branch: 'feature/abc-2', subject: 'Merge feature/abc-2 (#9)', body: '' },
      realGit,
    );

    expect(result.ok, `it refused: ${result.reason}`).toBe(true);
    expect(sh(seedDir, 'ls-remote', bareDir, 'develop')).toContain(result.mergeSha?.slice(0, 8) ?? 'no sha');
  });
});
