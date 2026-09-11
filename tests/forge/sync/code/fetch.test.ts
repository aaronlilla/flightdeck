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
        if (checkout === 'D:/work/backend-api') throw new Error('fetch failed: network unreachable');
        return '';
      },
      async gh() {
        throw new Error('fetchRepos must never call gh');
      },
      repos: [
        { repo: 'aaronlilla/mobile-app', checkout: 'D:/work/mobile-app', base: 'develop' },
        { repo: 'aaronlilla/backend-api', checkout: 'D:/work/backend-api', base: 'develop' },
        { repo: 'aaronlilla/flightdeck', checkout: 'D:/work/flightdeck', base: 'main' },
      ],
      claimedPaths: () => [],
      worktreeStatus: () => undefined,
      now: () => 0,
    };

    const result = await fetchRepos(deps);

    expect(result.fetched).toEqual(['aaronlilla/mobile-app', 'aaronlilla/flightdeck']);
    expect(result.failed).toEqual([
      { repo: 'aaronlilla/backend-api', message: 'fetch failed: network unreachable' },
    ]);
    expect(gitCalls).toEqual([
      { checkout: 'D:/work/mobile-app', argv: ['fetch', '--quiet', 'origin', 'develop'] },
      { checkout: 'D:/work/backend-api', argv: ['fetch', '--quiet', 'origin', 'develop'] },
      { checkout: 'D:/work/flightdeck', argv: ['fetch', '--quiet', 'origin', 'main'] },
    ]);
  });
});
