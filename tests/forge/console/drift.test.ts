/**
 * `computeDrift`: the ticket sheet's own git-backed drift facts, with a fake `git` so
 * this specimen never shells out.
 */
import { describe, expect, it } from 'vitest';

import { computeDrift, type GitFn } from '../../../src/forge/console/drift.js';

function fakeGit(responses: Record<string, { ok: boolean; tail: string }>): GitFn {
  return async (_checkout, argv) => {
    const key = argv[0]!;
    return responses[key] ?? { ok: false, tail: '' };
  };
}

describe('computeDrift', () => {
  it('answers behindBase: null with no checkout configured for the repo', async () => {
    const drift = computeDrift({ checkoutFor: () => undefined, git: fakeGit({}) });
    const result = await drift({ repo: 'o/n', base: 'develop', pr: 9, headSha: 'h1', attestationHead: 'h1' });
    expect(result).toEqual({ behindBase: null, headMoved: false });
  });

  it('reports headMoved by comparing the PR head to the attestation head, independent of git', async () => {
    const drift = computeDrift({ checkoutFor: () => undefined, git: fakeGit({}) });
    const result = await drift({ repo: 'o/n', base: 'develop', pr: 9, headSha: 'h2', attestationHead: 'h1' });
    expect(result.headMoved).toBe(true);
  });

  it('never claims headMoved with no attestation on record', async () => {
    const drift = computeDrift({ checkoutFor: () => undefined, git: fakeGit({}) });
    const result = await drift({ repo: 'o/n', base: 'develop', pr: 9, headSha: 'h2', attestationHead: null });
    expect(result.headMoved).toBe(false);
  });

  it('counts commits the base gained since the merge-base', async () => {
    const drift = computeDrift({
      checkoutFor: () => '/checkout/o-n',
      git: fakeGit({
        fetch: { ok: true, tail: '' },
        'merge-base': { ok: true, tail: 'mergebasesha\n' },
        'rev-list': { ok: true, tail: '5\n' },
      }),
    });
    const result = await drift({ repo: 'o/n', base: 'develop', pr: 9, headSha: 'h1', attestationHead: 'h1' });
    expect(result.behindBase).toBe(5);
  });

  it('answers behindBase: null when the fetch fails, never a guessed 0', async () => {
    const drift = computeDrift({
      checkoutFor: () => '/checkout/o-n',
      git: fakeGit({ fetch: { ok: false, tail: 'fatal: could not fetch' } }),
    });
    const result = await drift({ repo: 'o/n', base: 'develop', pr: 9, headSha: 'h1', attestationHead: 'h1' });
    expect(result.behindBase).toBeNull();
  });

  it('answers behindBase: null when merge-base fails', async () => {
    const drift = computeDrift({
      checkoutFor: () => '/checkout/o-n',
      git: fakeGit({ fetch: { ok: true, tail: '' }, 'merge-base': { ok: false, tail: '' } }),
    });
    const result = await drift({ repo: 'o/n', base: 'develop', pr: 9, headSha: 'h1', attestationHead: 'h1' });
    expect(result.behindBase).toBeNull();
  });
});
