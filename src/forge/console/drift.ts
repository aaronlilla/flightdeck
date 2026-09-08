/**
 * Drift facts for the ticket sheet's readiness line (2026-09-07): whether the PR's head
 * has moved past the sha the attestation actually reviewed, and how many commits the
 * base branch has gained since the PR's own merge-base. Both read fresh off git in the
 * repo's local checkout (`FORGE_REPO_CHECKOUTS`), never off a cached PR snapshot.
 *
 * `git` is injected so a specimen never shells out; `defaultGit` is the only place this
 * module actually spawns a process, and every call it makes is wall-bounded.
 */
import { checkoutFor } from '../chain-env.js';
import type { ChainEnv } from '../chain-env.js';
import { run as execRun, type RunRequest } from '../exec.js';

export interface DriftFacts {
  behindBase: number | null;
  headMoved: boolean;
  /** The PR's own commit subjects, `git log --format=%s <merge-base>..<head>` against
   *  `origin/<base>` -- newest first, six at most. `undefined`/empty whenever the range
   *  could not be read (no checkout, a failed fetch or merge-base), never a guess drawn
   *  from the worktree's whole history. */
  commits?: string[];
}

export interface DriftInput {
  repo: string;
  base: string;
  pr: number;
  /** The PR's own current head sha, off `gh pr view`. `null` when nobody has read it
   *  yet, which reads as "cannot say whether the head moved" rather than `false`. */
  headSha: string | null;
  /** The head sha the attestation was written against. `null` when there is no
   *  attestation on record at all. */
  attestationHead: string | null;
}

export type GitFn = (checkout: string, argv: string[]) => Promise<{ ok: boolean; tail: string }>;

export type DriftFn = (input: DriftInput) => Promise<DriftFacts>;

const DRIFT_WALL_MS = 20_000;

/** The two facts this module reports never call the same git twice: `headMoved` is a
 *  string comparison the caller already has both halves of, and `behindBase` is the
 *  only thing that needs a shell. A repo with no `FORGE_REPO_CHECKOUTS` entry, or a
 *  fetch that fails, answers `behindBase: null` -- never a guessed 0. */
const MAX_DRIFT_COMMITS = 6;

export function computeDrift(deps: { checkoutFor: (repo: string) => string | undefined; git: GitFn }): DriftFn {
  return async ({ repo, base, pr, headSha, attestationHead }) => {
    const headMoved = Boolean(headSha && attestationHead) && headSha !== attestationHead;
    const checkout = deps.checkoutFor(repo);
    if (!checkout) return { behindBase: null, headMoved, commits: [] };

    const headRef = `refs/forge/console-drift-pr-${pr}`;
    const baseRef = 'refs/forge/console-drift-base';
    const fetched = await deps.git(checkout, ['fetch', '--force', 'origin', `${base}:${baseRef}`, `pull/${pr}/head:${headRef}`]);
    if (!fetched.ok) return { behindBase: null, headMoved, commits: [] };

    const mergeBase = await deps.git(checkout, ['merge-base', headRef, baseRef]);
    if (!mergeBase.ok) return { behindBase: null, headMoved, commits: [] };
    const mergeBaseSha = mergeBase.tail.trim();
    if (!mergeBaseSha) return { behindBase: null, headMoved, commits: [] };

    const counted = await deps.git(checkout, ['rev-list', '--count', `${mergeBaseSha}..${baseRef}`]);
    const behindBase = counted.ok ? Number.parseInt(counted.tail.trim(), 10) || 0 : null;

    // The PR's own commits, newest first -- `git log`'s default order needs no
    // `--reverse`, unlike the story panel's whole-worktree timeline.
    const logged = await deps.git(checkout, ['log', '--format=%s', `${mergeBaseSha}..${headRef}`]);
    const commits = logged.ok
      ? logged.tail.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_DRIFT_COMMITS)
      : [];
    return { behindBase, headMoved, commits };
  };
}

function defaultGit(spawnFn?: RunRequest['spawnFn']): GitFn {
  return async (checkout, argv) => {
    const result = await execRun({
      argv: ['git', '-C', checkout, ...argv], cwd: checkout, owner: 'console-drift', cls: 'script',
      wall: DRIFT_WALL_MS, ...(spawnFn ? { spawnFn } : {}),
    });
    return { ok: result.ok, tail: result.tail };
  };
}

/** The production wiring: `FORGE_REPO_CHECKOUTS` for the checkout, real git for the
 *  fetch/merge-base/rev-list calls. A specimen builds `computeDrift` directly with a
 *  fake `git` instead of calling this. */
export function gitDrift(chainEnv: ChainEnv, spawnFn?: RunRequest['spawnFn']): DriftFn {
  return computeDrift({ checkoutFor: (repo) => checkoutFor(chainEnv, repo), git: defaultGit(spawnFn) });
}
