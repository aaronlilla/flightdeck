/** Fetches every configured repo's base branch. A failure for one repo never stops the others. */
import type { CodeSyncDeps } from './index.ts';

export interface FetchReposResult {
  fetched: string[];
  failed: Array<{ repo: string; message: string }>;
}

export async function fetchRepos(deps: CodeSyncDeps): Promise<FetchReposResult> {
  const fetched: string[] = [];
  const failed: FetchReposResult['failed'] = [];

  for (const { repo, checkout, base } of deps.repos) {
    try {
      await deps.git(checkout, ['fetch', '--quiet', 'origin', base]);
      fetched.push(repo);
    } catch (err) {
      failed.push({ repo, message: (err as Error).message });
    }
  }

  return { fetched, failed };
}
