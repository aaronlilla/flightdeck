import { describe, it, expect } from 'vitest';
import { readGitHead } from '../git-head';

describe('readGitHead', () => {
  it('formats the branch and short sha', () => {
    const git = {
      run: (args: string[]) => (args.includes('--abbrev-ref') ? 'feature/desktop-app\n' : '643fb25\n'),
    };
    expect(readGitHead(git, '/repo')).toBe('feature/desktop-app @ 643fb25');
  });

  it('returns undefined when git throws (not a repo, or git missing)', () => {
    const git = { run: () => { throw new Error('not a git repository'); } };
    expect(readGitHead(git, '/repo')).toBeUndefined();
  });

  it('returns undefined when either value comes back blank', () => {
    const git = { run: () => '' };
    expect(readGitHead(git, '/repo')).toBeUndefined();
  });
});
