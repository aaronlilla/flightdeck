/**
 * Reconciles ticket keys against every repo's open/merged/closed PRs so shipped work is
 * never re-queued and open work is adopted. One key may hit two repos (a frontend and
 * backend half); both entries are returned.
 */
import { branchFor } from '../../chain-env.ts';
import type { CodeSyncDeps } from './index.ts';

export interface ReconcilePrsResult {
  shipped: Array<{ key: string; repo: string; pr: number }>;
  open: Array<{ key: string; repo: string; pr: number; branch: string }>;
  none: string[];
}

interface GhPrRow {
  number: number;
  state: string;
  mergedAt: string | null;
  headRefName: string;
}

/** A branch name can be reused after its earlier PR merged or closed, so `gh pr list
 *  --head` can return more than one row -- the same case `worktrees.ts#pickPrRow`
 *  guards against. An OPEN row always outranks a stale merged/closed one. */
function pickPrRow(rows: GhPrRow[]): GhPrRow | undefined {
  return rows.find((row) => row.state === 'OPEN') ?? rows[0];
}

export async function reconcilePrs(deps: CodeSyncDeps, keys: string[]): Promise<ReconcilePrsResult> {
  const shipped: ReconcilePrsResult['shipped'] = [];
  const open: ReconcilePrsResult['open'] = [];
  const none: string[] = [];
  let failed = 0;

  for (const key of keys) {
    const branch = branchFor(key);
    for (const { repo, checkout } of deps.repos) {
      try {
        const out = await deps.gh(
          ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,mergedAt,headRefName'],
          checkout,
        );
        const rows = JSON.parse(out) as GhPrRow[];
        const row = pickPrRow(rows);
        if (!row) {
          none.push(key);
        } else if (row.mergedAt) {
          shipped.push({ key, repo, pr: row.number });
        } else if (row.state === 'OPEN') {
          open.push({ key, repo, pr: row.number, branch });
        } else {
          none.push(key);
        }
      } catch (err) {
        failed += 1;
        none.push(key);
        console.error(`reconcilePrs: gh failed for ${key} in ${repo}: ${(err as Error).message} (failed=${failed})`);
      }
    }
  }

  return { shipped, open, none };
}
