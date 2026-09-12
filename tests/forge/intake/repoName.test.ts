/**
 * Review finding, 2026-09-12: a repository name taken from a worktree path came back as
 * the SLUG, not the repository.
 *
 * Every worktree in this workspace is named `<repo>--<slug>`. Stripping `^.*--` off
 * `v2-react-native--ticket-friction` leaves `ticket-friction`, which is in no contract's
 * `outward_repos`, so every gate keyed on the repository silently became a no-op for any
 * work done in a worktree — which is where all of it is done. The comment at
 * `rules/readability.ts` already warns that exactly this failure makes "every gate
 * downstream a no-op"; the strip itself pointed the wrong way.
 */
import { describe, it, expect } from 'vitest';
import { repoNameFrom } from '../../../src/forge/intake/readability.ts';

describe('repoNameFrom', () => {
  it('takes the repository out of a worktree path, not the slug', () => {
    expect(repoNameFrom('C:/dev/worktrees/v2-react-native--ticket-friction')).toBe('v2-react-native');
    expect(repoNameFrom('C:\\dev\\worktrees\\v2-react-native--bbz-253')).toBe('v2-react-native');
    expect(repoNameFrom('/home/x/worktrees/acme-app--some--slug--with--dashes')).toBe('acme-app');
  });

  it('leaves an ordinary checkout path alone', () => {
    expect(repoNameFrom('C:/dev/v2-React-Native')).toBe('v2-react-native');
    expect(repoNameFrom('C:/dev/flightdeck')).toBe('flightdeck');
  });

  it('takes the name out of an owner/name slug', () => {
    expect(repoNameFrom('BOLTBETZ-LLC/v2-React-Native')).toBe('v2-react-native');
    expect(repoNameFrom('acme-app')).toBe('acme-app');
  });

  it('answers null for nothing', () => {
    expect(repoNameFrom(null)).toBeNull();
    expect(repoNameFrom('')).toBeNull();
    expect(repoNameFrom(undefined)).toBeNull();
  });
});
