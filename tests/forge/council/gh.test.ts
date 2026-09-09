/**
 * The pure pieces of `council/gh.ts`: counting a diff's changed lines and folding a
 * `statusCheckRollup` into one conclusion. No `gh` call anywhere in this file.
 */
import { describe, expect, it } from 'vitest';

import { conclusionOf, countAddDel, countChangedLines, parseGhJson } from '../../../src/forge/council/gh.ts';

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

describe('countAddDel: A.8', () => {
  it('splits added and removed content lines, never the +++/--- file headers', () => {
    const diff = [
      '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,3 @@',
      '-old line', '+new line one', '+new line two', ' unchanged',
    ].join('\n');
    expect(countAddDel(diff)).toEqual({ add: 2, del: 1 });
  });

  it('an empty diff has no adds or dels', () => {
    expect(countAddDel('')).toEqual({ add: 0, del: 0 });
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

describe('parseGhJson', () => {
  it('a failed gh call throws gh\'s own error text, never a JSON.parse syntax error', () => {
    // The exact shape a failing `gh pr view` produces: a non-zero exit whose combined
    // output is GitHub's GraphQL error text, not JSON -- reproduces the queue tick's
    // repeating "Unexpected token 'G', "GraphQL: A"... is not valid JSON" failure.
    const failed = { ok: false, tail: 'GraphQL: A pull request must be open to be merged (pullRequest)' };
    expect(() => parseGhJson(failed, 'pr view')).toThrow(
      /gh pr view failed: GraphQL: A pull request must be open/,
    );
  });

  it('an ok result with unparseable output throws a labeled error, not a bare syntax error', () => {
    const oddball = { ok: true, tail: 'not json at all' };
    expect(() => parseGhJson(oddball, 'pr view')).toThrow(
      /gh pr view returned output that is not JSON: not json at all/,
    );
  });

  it('an ok result with valid JSON parses through untouched', () => {
    const ok = { ok: true, tail: JSON.stringify({ headRefOid: 'abc123' }) };
    expect(parseGhJson<{ headRefOid: string }>(ok, 'pr view')).toEqual({ headRefOid: 'abc123' });
  });

  it('prefers full over tail, same as every other gh JSON reader in this codebase', () => {
    const ok = { ok: true, tail: '{truncated', full: JSON.stringify({ headRefOid: 'full-value' }) };
    expect(parseGhJson<{ headRefOid: string }>(ok, 'pr view')).toEqual({ headRefOid: 'full-value' });
  });
});
