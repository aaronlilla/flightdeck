import { describe, expect, it } from 'vitest';

import { repoFromBrief } from '../../../src/forge/intake/repoRoute.js';

// A pasted brief carries no ticket, so the label rules cannot place it; the `repo:` line
// is the only way a brief in the Queue view reaches a repository other than the default.
describe('repoFromBrief', () => {
  it('reads a repo line anywhere in the first twenty lines, any case, any spacing', () => {
    expect(repoFromBrief(['# Goal: x', '', 'repo: owner/tools', ''].join('\n'))).toBe('owner/tools');
    expect(repoFromBrief(['Repo :  Some-Org/front.end_app  ', 'body'].join('\n'))).toBe('Some-Org/front.end_app');
  });

  it('returns null without a line, and for a value that is not owner/name', () => {
    expect(repoFromBrief(['# Goal: x', '', 'no header here'].join('\n'))).toBeNull();
    expect(repoFromBrief('repo: tools')).toBeNull();
    expect(repoFromBrief('repo: https://example.test/a/b')).toBeNull();
    expect(repoFromBrief('repository: a/b')).toBeNull();
  });

  it('ignores a repo line past the first twenty lines', () => {
    const late = `${'x\n'.repeat(25)}repo: a/b\n`;
    expect(repoFromBrief(late)).toBeNull();
  });
});
