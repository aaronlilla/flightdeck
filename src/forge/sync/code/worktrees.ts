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

async function lookupPr(deps: CodeSyncDeps, repo: string, cwd: string, branch: string): Promise<GhPrRow | null | 'error'> {
  try {
    const out = await deps.gh(
      ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,mergedAt'],
      cwd,
    );
    const rows = JSON.parse(out) as GhPrRow[];
    return rows[0] ?? null;
  } catch {
    return 'error';
  }
}

export async function sweepWorktrees(
  deps: CodeSyncDeps,
  opts?: { dryRun?: boolean },
): Promise<SweepWorktreesResult> {
  const dryRun = opts?.dryRun ?? false;
  const removed: SweptWorktree[] = [];
  const kept: SweptWorktree[] = [];
  const claimedAtStart = new Set(deps.claimedPaths());

  for (const { repo, checkout } of deps.repos) {
    const listing = await deps.git(checkout, ['worktree', 'list', '--porcelain']);
    const entries = parsePorcelain(listing);
    if (entries.length === 0) continue;
    const [, ...rest] = entries; // first entry is the main checkout

    for (const entry of rest) {
      const branch = entry.branch ?? '';
      if (!entry.branch) {
        kept.push({ path: entry.path, branch, reason: 'main-checkout' });
        continue;
      }

      const status = deps.worktreeStatus(entry.path);
      if (!status || !status.clean) {
        kept.push({ path: entry.path, branch, reason: 'dirty' });
        continue;
      }
      if (!status.pushed) {
        kept.push({ path: entry.path, branch, reason: 'unpushed' });
        continue;
      }
      if (claimedAtStart.has(entry.path)) {
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
      if (deps.claimedPaths().includes(entry.path)) {
        kept.push({ path: entry.path, branch, reason: 'claimed-after-snapshot' });
        continue;
      }

      const reason = pr.mergedAt ? 'merged-clean' : 'closed-clean';
      if (!dryRun) {
        await deps.git(checkout, ['worktree', 'remove', entry.path]);
        await deps.git(checkout, ['branch', '-D', branch]);
      }
      removed.push({ path: entry.path, branch, reason });
    }
  }

  return { removed, kept };
}
