/**
 * Review finding, 2026-09-12: a repository name taken from a worktree path came back as
 * the SLUG, not the repository.
 *
 * Worktrees in this workspace are named `<repo>--<slug>`. Stripping `^.*--` off
 * `acme-app--ticket-friction` leaves `ticket-friction`, which is in no contract's
 * `outward_repos`, so every gate keyed on the repository silently became a no-op for any
 * work done in a worktree -- which is where all of it is done. The comment in
 * `rules/readability.ts` already warns that exactly this failure makes "every gate
 * downstream a no-op"; the strip itself pointed the wrong way.
 */
import { describe, it, expect } from 'vitest';
import { repoNameFrom } from '../../../src/forge/intake/readability.ts';

describe('repoNameFrom', () => {
  it('takes the repository out of a worktree path, not the slug', () => {
    expect(repoNameFrom('/work/worktrees/acme-app--ticket-friction')).toBe('acme-app');
    expect(repoNameFrom('D:\\work\\worktrees\\acme-app--acme-1')).toBe('acme-app');
    expect(repoNameFrom('/work/worktrees/acme-app--some--slug--with--dashes')).toBe('acme-app');
  });

  it('leaves an ordinary checkout path alone', () => {
    expect(repoNameFrom('/work/Acme-App')).toBe('acme-app');
    expect(repoNameFrom('/work/acme-api')).toBe('acme-api');
  });

  it('takes the name out of an owner/name slug', () => {
    expect(repoNameFrom('ACME-ORG/Acme-App')).toBe('acme-app');
    expect(repoNameFrom('acme-app')).toBe('acme-app');
  });

  it('answers null for nothing', () => {
    expect(repoNameFrom(null)).toBeNull();
    expect(repoNameFrom('')).toBeNull();
    expect(repoNameFrom(undefined)).toBeNull();
  });
});
