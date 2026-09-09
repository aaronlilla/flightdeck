/**
 * `chainRebase` (chain-wire.ts) against real git repositories -- the exact shape hit
 * live on 2026-09-08: a worker commits its own work, opens no PR issue on the branch
 * itself, but leaves one or two files modified/untracked in the worktree. The pre-gate
 * rebase used to refuse outright ("You have unstaged changes"), parking the item for a
 * person to commit the leftovers by hand. This proves the rebase now commits those
 * leftovers itself before replaying onto the base, and still parks on a real content
 * conflict.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { chainRebase } from '../../../src/forge/chain-wire.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'worker@example.com']);
  git(dir, ['config', 'user.name', 'Forge Worker']);
}

/** A base repo with one commit, plus a worktree-clone already on `feature`, so
 *  `origin/main` can move independently of the clone the way a long-lived queue tick
 *  sees it. */
function setup(): { base: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'chain-rebase-'));
  const base = join(root, 'base');
  initRepo(base);
  writeFileSync(join(base, 'shared.ts'), 'export const value = 1;\n');
  writeFileSync(join(base, 'tests-setup.ts'), 'export const setup = 1;\n');
  git(base, ['add', '-A']);
  git(base, ['commit', '-m', 'initial']);

  const worktree = join(root, 'worktree');
  git(root, ['clone', base, worktree]);
  git(worktree, ['config', 'user.email', 'worker@example.com']);
  git(worktree, ['config', 'user.name', 'Forge Worker']);
  git(worktree, ['checkout', '-b', 'feature/abc-1']);
  writeFileSync(join(worktree, 'feature.ts'), 'export const feature = true;\n');
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-m', 'worker: add feature']);

  return { base, worktree };
}

describe('chainRebase', () => {
  it('commits a leftover modified tracked file and an untracked file, then rebases cleanly', async () => {
    const { base, worktree } = setup();

    // main moves on independently, same as any other item landing while this one ran.
    writeFileSync(join(base, 'other.ts'), 'export const other = 1;\n');
    git(base, ['add', '-A']);
    git(base, ['commit', '-m', 'unrelated: other change on main']);

    // The worker committed its feature, but left these behind uncommitted -- the exact
    // shape of Q-0fb06912 (tests/setup.ts) and Q-56440c7b (two test files).
    writeFileSync(join(worktree, 'tests-setup.ts'), 'export const setup = 2;\n');
    writeFileSync(join(worktree, 'tests-new.ts'), 'export const brandNew = true;\n');

    const rebase = chainRebase();
    const outcome = await rebase({ worktreePath: worktree, base: 'main' });

    expect(outcome.ok).toBe(true);
    expect(outcome.behind).toBe(1);
    expect(outcome.committedLeftover).toEqual(expect.arrayContaining(['tests-setup.ts', 'tests-new.ts']));

    // The tree is clean and the rebase actually replayed onto main's new tip.
    const status = git(worktree, ['status', '--porcelain']);
    expect(status.trim()).toBe('');
    const log = git(worktree, ['log', '--oneline', '-5']);
    expect(log).toContain('unrelated: other change on main');
    expect(readFileSync(join(worktree, 'tests-setup.ts'), 'utf8')).toContain('setup = 2');
    expect(readFileSync(join(worktree, 'tests-new.ts'), 'utf8')).toContain('brandNew');
  }, 20_000);

  it('a real content conflict on the base still parks, with the git output in the reason', async () => {
    const { base, worktree } = setup();

    // main changes the very line the worker's own commit already changed -- a real
    // conflict, never something committing leftovers can paper over.
    writeFileSync(join(base, 'shared.ts'), 'export const value = 2;\n');
    git(base, ['add', '-A']);
    git(base, ['commit', '-m', 'main: bump shared value']);

    writeFileSync(join(worktree, 'shared.ts'), 'export const value = 3;\n');
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-m', 'worker: also bump shared value']);

    const rebase = chainRebase();
    const outcome = await rebase({ worktreePath: worktree, base: 'main' });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBeTruthy();
    expect(outcome.reason).not.toMatch(/unstaged changes/i);

    // Left exactly as found: no half-finished rebase sitting in the worktree.
    const rebaseInProgress = git(worktree, ['status', '--porcelain=v1', '--branch']);
    expect(rebaseInProgress).not.toContain('rebasing');
  }, 20_000);
});
