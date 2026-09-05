/**
 * The pure pieces of `council/gh.ts`: counting a diff's changed lines and folding a
 * `statusCheckRollup` into one conclusion. No `gh` call anywhere in this file.
 */
import { describe, expect, it } from 'vitest';

import { conclusionOf, countChangedLines } from '../../../src/forge/council/gh.ts';

describe('countChangedLines', () => {
  it('counts added and removed content lines, never the +++/--- file headers', () => {
    const diff = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,3 @@',
      '-old line',
      '+new line one',
      '+new line two',
      ' unchanged',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(3);
  });

  it('an empty diff has no changed lines', () => {
    expect(countChangedLines('')).toBe(0);
  });
});

describe('conclusionOf', () => {
  it('no checks at all reads as pending, never as a guessed success', () => {
    expect(conclusionOf(undefined)).toBe('pending');
    expect(conclusionOf([])).toBe('pending');
  });

  it('every check succeeding reads as success', () => {
    expect(conclusionOf([{ conclusion: 'SUCCESS' }, { conclusion: 'success' }])).toBe('success');
  });

  it('any failing check reads as failure', () => {
    expect(conclusionOf([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('failure');
  });

  it('a check still in progress reads as pending, not as a passing check', () => {
    expect(conclusionOf([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toBe('pending');
  });

  it('a rollup of four StatusContext SUCCESS rows (state, no conclusion or status) reads success', () => {
    expect(conclusionOf([
      { state: 'SUCCESS' },
      { state: 'SUCCESS' },
      { state: 'SUCCESS' },
      { state: 'SUCCESS' },
    ])).toBe('success');
  });

  it('a mixed rollup with one CheckRun in progress alongside StatusContext successes reads pending', () => {
    expect(conclusionOf([
      { state: 'SUCCESS' },
      { state: 'SUCCESS' },
      { status: 'IN_PROGRESS' },
    ])).toBe('pending');
  });

  it('one StatusContext FAILURE among successes reads failure', () => {
    expect(conclusionOf([
      { state: 'SUCCESS' },
      { state: 'FAILURE' },
    ])).toBe('failure');
  });
});
