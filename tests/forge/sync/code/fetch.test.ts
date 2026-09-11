import { describe, expect, it } from 'vitest';

import { fetchRepos } from '../../../../src/forge/sync/code/fetch.ts';
import type { CodeSyncDeps } from '../../../../src/forge/sync/code/index.ts';

interface GitCall { checkout: string; argv: string[] }

describe('fetchRepos', () => {
  it('fetches every repo, carrying one failure without stopping the others', async () => {
    const gitCalls: GitCall[] = [];
    const deps: CodeSyncDeps = {
      async git(checkout, argv) {
        gitCalls.push({ checkout, argv });
        if (checkout === 'C:/dev/BBManagementSystemV2') throw new Error('fetch failed: network unreachable');
        return '';
      },
      async gh() {
        throw new Error('fetchRepos must never call gh');
      },
      repos: [
        { repo: 'aaronlilla/v2-React-Native', checkout: 'C:/dev/v2-React-Native', base: 'develop' },
        { repo: 'aaronlilla/BBManagementSystemV2', checkout: 'C:/dev/BBManagementSystemV2', base: 'develop' },
        { repo: 'aaronlilla/flightdeck', checkout: 'C:/dev/flightdeck', base: 'main' },
      ],
      claimedPaths: () => [],
      worktreeStatus: () => undefined,
      now: () => 0,
    };

    const result = await fetchRepos(deps);

    expect(result.fetched).toEqual(['aaronlilla/v2-React-Native', 'aaronlilla/flightdeck']);
    expect(result.failed).toEqual([
      { repo: 'aaronlilla/BBManagementSystemV2', message: 'fetch failed: network unreachable' },
    ]);
    expect(gitCalls).toEqual([
      { checkout: 'C:/dev/v2-React-Native', argv: ['fetch', '--quiet', 'origin', 'develop'] },
      { checkout: 'C:/dev/BBManagementSystemV2', argv: ['fetch', '--quiet', 'origin', 'develop'] },
      { checkout: 'C:/dev/flightdeck', argv: ['fetch', '--quiet', 'origin', 'main'] },
    ]);
  });
});
