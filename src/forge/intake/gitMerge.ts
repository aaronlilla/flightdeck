/**
 * R-22: the Merge click's actual merge, done as git rather than `gh pr merge`.
 *
 * At 23:05 on 2026-09-08, with eight lanes running, GitHub answered "API rate limit
 * already exceeded" and held a secondary limit on mutations for the following half
 * hour -- every gate's `gh pr merge` call refused, and nothing that had already been
 * reviewed could land. Git's own push/fetch transport is not metered by that budget,
 * so `mergeItem` (`queue.ts`) calls `gitSquashMergeToBase` here instead, once
 * `QueueMergeDeps.gitMerge` is wired: fetch, squash-merge the branch onto a local
 * checkout of the base, commit with the PR's own title as the subject, push. The PR
 * itself is left open -- GitHub closes it on its own once it sees the merge commit
 * reachable from the base branch, so nothing here calls `gh` at all.
 */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
}

/** Injectable so a specimen can run against a real bare-remote git fixture without ever
 *  going near `gh`, and so production wiring (`queue-wire.ts`) can route through the
 *  same budgeted `run()` every other git call in this repo already uses. */
export type GitRunFn = (argv: string[], cwd: string) => Promise<GitRunResult>;

export interface GitSquashMergeInput {
  /** A local checkout of `base`, e.g. this repo's `FORGE_REPO_CHECKOUTS` entry. */
  checkoutDir: string;
  base: string;
  branch: string;
  subject: string;
  body: string;
}

export interface GitSquashMergeResult {
  ok: boolean;
  mergeSha?: string;
  reason?: string;
}

/**
 * Fetches `base` and `branch` fresh from `origin`, resets the checkout onto
 * `origin/<base>` (so a checkout another session left mid-rebase never poisons this
 * merge), squash-merges `branch` onto it, commits with the PR's own title as the
 * subject, and pushes straight back to `base`. Any step failing aborts the merge in
 * progress rather than leaving the checkout half-squashed, and reports why, so a
 * refused push (a concurrent merge moved `base` first) reads as that, not a bare
 * `ok: false`.
 */
export async function gitSquashMergeToBase(input: GitSquashMergeInput, runGit: GitRunFn): Promise<GitSquashMergeResult> {
  const { checkoutDir, base, branch, subject, body } = input;
  const git = (argv: string[]) => runGit(argv, checkoutDir);

  const fetch = await git(['fetch', 'origin', base, branch]);
  if (!fetch.ok) return { ok: false, reason: `could not fetch origin/${base} and origin/${branch}` };

  // Detached, never `checkout -B <base>`. Claiming the branch by name fails outright when
  // another worktree of the same repository already holds it -- "fatal: 'main' is already
  // used by worktree at ..." -- which is the normal shape here: the checkout this merges
  // in is usually a worktree, and the repository's own main checkout holds the base.
  // Measured 2026-09-12: a ticket driven in through the console reached review and every
  // Merge refused with "could not check out origin/main".
  //
  // Nothing below needs the branch name locally: the squash, the commit and the push all
  // work off HEAD, and the push already names `HEAD:<base>`.
  const checkout = await git(['checkout', '--detach', `origin/${base}`]);
  if (!checkout.ok) return { ok: false, reason: `could not check out origin/${base}` };

  const merge = await git(['merge', '--squash', `origin/${branch}`]);
  if (!merge.ok) {
    await git(['merge', '--abort']);
    return { ok: false, reason: `squash merge of origin/${branch} onto ${base} failed` };
  }

  const commit = await git(body ? ['commit', '-m', subject, '-m', body] : ['commit', '-m', subject]);
  if (!commit.ok) {
    await git(['reset', '--hard', `origin/${base}`]);
    return { ok: false, reason: 'commit failed -- nothing to merge, or a pre-commit hook refused it' };
  }

  const push = await git(['push', 'origin', `HEAD:${base}`]);
  if (!push.ok) {
    return { ok: false, reason: `push to origin/${base} was refused -- a concurrent push likely moved it first` };
  }

  const revParse = await git(['rev-parse', 'HEAD']);
  return { ok: true, ...(revParse.ok ? { mergeSha: revParse.stdout.trim() } : {}) };
}
