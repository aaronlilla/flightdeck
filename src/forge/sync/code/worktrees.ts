/**
 * Sweeps stale worktrees a repo's `git worktree list` still carries after their branch
 * shipped or died. Never runs real git or gh directly -- every effect comes through
 * `CodeSyncDeps` so a test can prove the decision table without touching a checkout.
 */
import type { CodeSyncDeps } from './index.ts';

export type { CodeSyncDeps };

export interface SweptWorktree {
  path: string;
  branch: string;
  reason: string;
}

export interface SweepWorktreesResult {
  removed: SweptWorktree[];
  kept: SweptWorktree[];
}

interface PorcelainEntry {
  path: string;
  branch: string | null;
}

function parsePorcelain(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let current: Partial<PorcelainEntry> | undefined;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('worktree ')) {
      if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: trimmed.slice('worktree '.length).trim(), branch: null };
    } else if (trimmed.startsWith('branch ') && current) {
      const ref = trimmed.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

interface GhPrRow {
  number: number;
  state: string;
  mergedAt: string | null;
}

/** A branch name can be reused after a worktree is removed and re-created, so `gh pr
 *  list --head` can return more than one PR for it. An OPEN row -- the branch's current
 *  state -- always outranks a stale merged/closed row from an earlier PR of the same
 *  name; otherwise the first row (gh's own ordering) stands. */
function pickPrRow(rows: GhPrRow[]): GhPrRow | null {
  if (rows.length === 0) return null;
  return rows.find((row) => row.state === 'OPEN') ?? rows[0]!;
}

async function lookupPr(deps: CodeSyncDeps, repo: string, cwd: string, branch: string): Promise<GhPrRow | null | 'error'> {
  try {
    const out = await deps.gh(
      ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,mergedAt'],
      cwd,
    );
    const rows = JSON.parse(out) as GhPrRow[];
    return pickPrRow(rows);
  } catch {
    return 'error';
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isClaimed(path: string, claimed: Iterable<string>): boolean {
  const target = normalizePath(path);
  for (const claim of claimed) {
    if (normalizePath(claim) === target) return true;
  }
  return false;
}

export async function sweepWorktrees(
  deps: CodeSyncDeps,
  opts?: { dryRun?: boolean },
): Promise<SweepWorktreesResult> {
  const dryRun = opts?.dryRun ?? false;
  const removed: SweptWorktree[] = [];
  const kept: SweptWorktree[] = [];
  const claimedAtStart = deps.claimedPaths();

  for (const { repo, checkout } of deps.repos) {
    const listing = await deps.git(checkout, ['worktree', 'list', '--porcelain']);
    const entries = parsePorcelain(listing);
    if (entries.length === 0) continue;
    const [mainEntry, ...rest] = entries;
    const mainCheckoutPaths = new Set(
      [mainEntry?.path, checkout].filter((p): p is string => Boolean(p)).map(normalizePath),
    );

    for (const entry of rest) {
      const branch = entry.branch ?? '';
      if (mainCheckoutPaths.has(normalizePath(entry.path))) {
        kept.push({ path: entry.path, branch, reason: 'main-checkout' });
        continue;
      }
      if (!entry.branch) {
        kept.push({ path: entry.path, branch, reason: 'detached' });
        continue;
      }

      let status: { clean: boolean; pushed: boolean } | undefined;
      try {
        status = deps.worktreeStatus(entry.path);
      } catch {
        kept.push({ path: entry.path, branch, reason: 'status-error' });
        continue;
      }
      if (!status || !status.clean) {
        kept.push({ path: entry.path, branch, reason: 'dirty' });
        continue;
      }
      if (!status.pushed) {
        kept.push({ path: entry.path, branch, reason: 'unpushed' });
        continue;
      }
      if (isClaimed(entry.path, claimedAtStart)) {
        kept.push({ path: entry.path, branch, reason: 'claimed' });
        continue;
      }

      const pr = await lookupPr(deps, repo, checkout, branch);
      if (pr === 'error') {
        kept.push({ path: entry.path, branch, reason: 'gh-error' });
        continue;
      }
      if (pr === null) {
        kept.push({ path: entry.path, branch, reason: 'no-pr' });
        continue;
      }
      if (pr.state === 'OPEN') {
        kept.push({ path: entry.path, branch, reason: 'pr-open' });
        continue;
      }

      const eligible = Boolean(pr.mergedAt) || pr.state === 'CLOSED';
      if (!eligible) {
        kept.push({ path: entry.path, branch, reason: 'no-pr' });
        continue;
      }

      // Re-read claims immediately before removal: a claim can appear while the sweep
      // is mid-way through dozens of gh calls.
      if (isClaimed(entry.path, deps.claimedPaths())) {
        kept.push({ path: entry.path, branch, reason: 'claimed-after-snapshot' });
        continue;
      }

      const reason = pr.mergedAt ? 'merged-clean' : 'closed-clean';
      if (!dryRun) {
        // A worktree git cannot remove (a file locked by a stuck process, a shell whose
        // cwd is inside it) is kept, named, and the sweep moves on. On 2026-09-11 one
        // such tree failed the whole full re-sync and left the fleet's kill switch on.
        try {
          await deps.git(checkout, ['worktree', 'remove', entry.path]);
          await deps.git(checkout, ['branch', '-D', branch]);
        } catch {
          kept.push({ path: entry.path, branch, reason: 'remove-error' });
          continue;
        }
      }
      removed.push({ path: entry.path, branch, reason });
    }
  }

  return { removed, kept };
}
