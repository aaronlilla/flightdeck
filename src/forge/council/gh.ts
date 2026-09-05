/**
 * Reads and writes GitHub state for a pull request Council is reviewing, through `gh`,
 * behind an injectable interface -- the same shape `sdkengine.ts`'s own `checkDrift` /
 * `ghDriftCheck` already use for the drift check. `forge council` and `forge gate` see
 * the real command line in production (`REAL_GH`); every specimen injects a fake here
 * instead. No specimen in this repository calls `REAL_GH` (guardrail: no `gh` call in
 * any test).
 */
import { run as execRun } from '../exec.ts';
import type { GhPrView } from './externalize.ts';

export interface PrSnapshot {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  files: string[];
  diffText: string;
  changedLines: number;
  checks: { runId: string; headSha: string; conclusion: 'success' | 'failure' | 'pending' };
  /** F5: `gh pr merge` refuses outright on a draft PR, with no reason surfaced anywhere
   *  in this codebase before this field existed. `forge gate --merge` reads it before
   *  ever calling `mergePr`. */
  isDraft: boolean;
}

/** Everything Council reads about a PR. One call, so a caller never risks reading the
 *  diff, the files and the checks off three points in time that disagree. */
export interface GhReader {
  viewPr(repo: string, pr: number): Promise<PrSnapshot>;
}

/** What a `gh` write reports back: the exit code and the combined output (`run()` in
 *  `exec.ts` merges stdout and stderr into one tail, so this is that tail, not a
 *  separately captured stream) -- F5's own fix for a merge that failed silently and
 *  left `forge gate` printing the bare word "unknown" with no way to tell why. */
export interface GhWriteResult {
  returncode: number;
  stderr: string;
}

/** The writes `forge gate --merge` performs, always through `ExternalWrite`'s own
 *  intent/call/complete cycle (`externalize.ts`) rather than fired and forgotten.
 *  `readyPr` (F5) is called first when the PR is still a draft: a passing gate is by
 *  construction what makes a draft ready to merge. */
export interface GhWriter {
  mergePr(repo: string, pr: number, subject: string, body: string): Promise<GhWriteResult>;
  readyPr(repo: string, pr: number): Promise<GhWriteResult>;
  viewPrState(repo: string, pr: number): Promise<GhPrView>;
}

/**
 * Counts changed lines the way a unified diff already tells us: an added or removed
 * content line, never a `+++`/`---` file header (those start with the same character
 * but are not a change).
 */
export function countChangedLines(diffText: string): number {
  let count = 0;
  for (const line of diffText.split('\n')) {
    const isAdd = line.startsWith('+') && !line.startsWith('+++');
    const isRemove = line.startsWith('-') && !line.startsWith('---');
    if (isAdd || isRemove) count += 1;
  }
  return count;
}

interface RawStatusCheck {
  conclusion?: string | null;
  status?: string | null;
  // `gh pr view --json statusCheckRollup` mixes two row shapes in the same array: a
  // GitHub Actions `CheckRun` carries `conclusion` (final) and `status` (while running),
  // but a commit status posted by an external CI (EAS included) is a `StatusContext` --
  // it never has `conclusion` or `status`, only `state`.
  state?: string | null;
}

interface RawPrView {
  headRefOid: string;
  baseRefOid: string;
  title: string;
  body: string;
  files?: { path: string }[];
  statusCheckRollup?: RawStatusCheck[];
  isDraft?: boolean;
}

/**
 * One overall conclusion off `gh pr view --json statusCheckRollup`'s own array: no
 * checks at all, or any check still running, reads as `pending` rather than a guess at
 * success; any failing check reads as `failure`; only every check succeeding reads as
 * `success`. `pending` is the safe default on the two shapes that are not a clear yes --
 * a check the reader could not read is not a check that passed.
 *
 * A `CheckRun` row is read off `conclusion` (falling back to `status` while it is still
 * running, so an in-progress run reads pending rather than falling through to `state`
 * and going unread). A `StatusContext` row -- what an external CI like EAS posts -- has
 * neither and is read off `state` instead.
 */
export function conclusionOf(rollup: RawStatusCheck[] | undefined): 'success' | 'failure' | 'pending' {
  if (!rollup || rollup.length === 0) return 'pending';
  const states = rollup.map((entry) => (entry.conclusion ?? entry.status ?? entry.state ?? '').toUpperCase());
  if (states.some((state) => state === '' || state === 'PENDING' || state === 'IN_PROGRESS' || state === 'QUEUED')) {
    return 'pending';
  }
  if (states.every((state) => state === 'SUCCESS')) return 'success';
  return 'failure';
}

/** Production wiring only. `cli.ts` is the sole caller; every specimen supplies its own
 *  `GhReader & GhWriter` instead. */
export const REAL_GH: GhReader & GhWriter = {
  async viewPr(repo, pr) {
    const view = await execRun({
      argv: [
        'gh', 'pr', 'view', String(pr), '--repo', repo, '--json',
        'headRefOid,baseRefOid,title,body,files,statusCheckRollup,isDraft',
      ],
      cwd: process.cwd(), owner: 'council', cls: 'script',
    });
    const parsed = JSON.parse(view.tail) as RawPrView;
    const diff = await execRun({
      argv: ['gh', 'pr', 'diff', String(pr), '--repo', repo],
      cwd: process.cwd(), owner: 'council', cls: 'script',
    });
    return {
      repo,
      pr,
      headSha: parsed.headRefOid,
      baseSha: parsed.baseRefOid,
      title: parsed.title,
      body: parsed.body ?? '',
      files: (parsed.files ?? []).map((entry) => entry.path),
      diffText: diff.tail,
      changedLines: countChangedLines(diff.tail),
      checks: {
        runId: `${repo}#${pr}@${parsed.headRefOid}`,
        headSha: parsed.headRefOid,
        conclusion: conclusionOf(parsed.statusCheckRollup),
      },
      isDraft: parsed.isDraft ?? false,
    };
  },

  async mergePr(repo, pr, subject, body) {
    const result = await execRun({
      argv: ['gh', 'pr', 'merge', String(pr), '--repo', repo, '--squash', '--subject', subject, '--body', body],
      cwd: process.cwd(), owner: 'council', cls: 'script',
    });
    return { returncode: result.returncode ?? -1, stderr: result.tail };
  },

  /** F5: marks a draft PR ready to merge. Called by `forge gate --merge` before the
   *  merge itself when `isDraft` says the PR is still a draft -- `gh pr merge` refuses
   *  a draft outright, and nothing upstream of this fix ever looked. */
  async readyPr(repo, pr) {
    const result = await execRun({
      argv: ['gh', 'pr', 'ready', String(pr), '--repo', repo],
      cwd: process.cwd(), owner: 'council', cls: 'script',
    });
    return { returncode: result.returncode ?? -1, stderr: result.tail };
  },

  async viewPrState(repo, pr) {
    const view = await execRun({
      argv: ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'state'],
      cwd: process.cwd(), owner: 'council', cls: 'script',
    });
    const parsed = JSON.parse(view.tail) as { state?: string };
    const prState = parsed.state === 'MERGED' ? 'MERGED' : parsed.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
    return { prState };
  },
};
