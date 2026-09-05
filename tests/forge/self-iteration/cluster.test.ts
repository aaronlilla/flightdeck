/**
 * Roadmap P4.6, F30's clustering requirement, dispatcher decision 5: gotchas that share
 * a tool name, a normalized error, and the same leading stack frames fold into one
 * cluster even when their `where`/`error` text differs -- the case `gotcha.ts`'s own
 * exact-match dedupe (hashing `where|error` verbatim) cannot see.
 */
import { describe, expect, it } from 'vitest';

import type { Gotcha } from '../../../src/forge/gotcha.js';
import { clusterGotchas, normalizeErrorText, toolNameFor, topFrames } from '../../../src/forge/self-iteration/cluster.js';

function fakeGotcha(overrides: Partial<Gotcha>): Gotcha {
  return {
    run: 'r1', what: 'x', where: 'npm test', error: 'boom', prevention: 'y',
    id: overrides.id ?? Math.random().toString(16).slice(2), at: Date.now(), hits: 1, runs: ['r1'],
    lane: 'fix', why: 'z', disposition: 'carry-on', ...overrides,
  };
}

describe('clusterGotchas: root-cause folding beyond identical-text dedupe', () => {
  it('folds two gotchas that differ only in a path and a pid into one cluster', () => {
    const a = fakeGotcha({
      id: 'a', where: 'npm run build', error: 'ENOENT: C:\\dev\\worktrees\\flightdeck--x\\dist\\main.js not found (pid 4821)',
    });
    const b = fakeGotcha({
      id: 'b', where: 'npm run build', error: 'ENOENT: C:\\dev\\worktrees\\flightdeck--y\\dist\\main.js not found (pid 9931)',
    });

    const clusters = clusterGotchas([a, b]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.gotchaIds.sort()).toEqual(['a', 'b']);
  });

  it('never folds two gotchas from different tools even with near-identical error text', () => {
    const a = fakeGotcha({ id: 'a', where: 'npm run build', error: 'timeout after 30000ms' });
    const b = fakeGotcha({ id: 'b', where: 'dotnet test', error: 'timeout after 45000ms' });

    const clusters = clusterGotchas([a, b]);

    expect(clusters).toHaveLength(2);
  });

  it('a gotcha structurally unlike any other stands alone as a cluster of one', () => {
    const solo = fakeGotcha({ id: 'solo', where: 'gh pr create', error: 'rate limited' });

    const clusters = clusterGotchas([solo]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.gotchaIds).toEqual(['solo']);
  });

  it('two gotchas with genuinely different root causes never cluster together (falsifier check)', () => {
    const a = fakeGotcha({ id: 'a', where: 'npm run build', error: 'ENOENT: dist/main.js not found' });
    const b = fakeGotcha({ id: 'b', where: 'npm run build', error: 'permission denied writing dist/main.js' });

    const clusters = clusterGotchas([a, b]);

    expect(clusters).toHaveLength(2);
  });
});

describe('toolNameFor / normalizeErrorText / topFrames', () => {
  it('takes the leading command word as the tool name, case-insensitively', () => {
    expect(toolNameFor('npm run build')).toBe('npm');
    expect(toolNameFor('C:\\dev\\dotnet.exe test')).toBe('dotnet');
  });

  it('masks numbers, paths and ids out of error text', () => {
    const masked = normalizeErrorText('failed at C:\\dev\\x\\y.ts line 42 (session 123e4567-e89b-12d3-a456-426614174000)');
    expect(masked).not.toMatch(/\d/);
    expect(masked).not.toContain('c:\\dev');
  });

  it('keeps only the top two frame-shaped lines', () => {
    const error = [
      'TypeError: boom',
      '    at foo (file.js:1:1)',
      '    at bar (file.js:2:2)',
      '    at baz (file.js:3:3)',
    ].join('\n');
    expect(topFrames(error)).toHaveLength(2);
  });
});
