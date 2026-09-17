/**
 * The blind-external-bar lens.
 *
 * What these specimens pin is the property that makes this lens different from every
 * other one: it compares against real merged artifacts rather than a rubric, the
 * comparison is like-for-like on size, and the corpus is explicitly a baseline the
 * artifact under review is allowed to beat.
 */
import { describe, expect, it } from 'vitest';

import {
  BAR_LENS_NAME, buildBarLensPrompt, comparableEntries, corpusShape, loadCorpus,
  countTestBlocks, parseClaimedTestCount,
  type Corpus,
} from '../../../src/forge/council/barLens.js';

function entry(number: number, additions: number, testFiles = 1, body = 'body text') {
  return {
    number, title: `PR ${number}`, body, bodyChars: body.length,
    changedFiles: 2, additions, deletions: 0, testFiles, testLines: testFiles ? 20 : 0,
  };
}

const corpus: Corpus = {
  repo: 'Example/Repo',
  total: 87,
  corpus: [entry(1, 10), entry(2, 40), entry(3, 500, 0), entry(4, 60), entry(5, 900, 0)],
};

describe('corpusShape', () => {
  it('uses medians, so one outlier PR cannot move the baseline', () => {
    const shape = corpusShape(corpus);
    // Additions are 10, 40, 60, 500, 900 -- the mean (302) would be dragged by the
    // 900-line refactor; the median is the typical artifact a maintainer receives.
    expect(shape.medianAdditions).toBe(60);
    expect(shape.count).toBe(5);
    expect(shape.withTests).toBe('3/5');
  });
});

describe('comparableEntries', () => {
  it('compares like for like, because a 30-line fix judged against a refactor proves nothing', () => {
    const picked = comparableEntries(corpus, 36, 3).map((e) => e.number);
    expect(picked).toEqual([2, 4, 1]);
    expect(picked).not.toContain(5);
  });

  it('picks the large PRs when the diff under review is itself large', () => {
    expect(comparableEntries(corpus, 880, 2).map((e) => e.number)).toEqual([5, 3]);
  });
});

describe('buildBarLensPrompt', () => {
  const prompt = buildBarLensPrompt({
    brief: 'OUR PR BODY', diffSummary: 'OUR DIFF', changedLines: 36, corpus,
  });

  it('carries real merged bodies verbatim, not a description of them', () => {
    expect(prompt).toContain('merged PR, 2 files');
    expect(prompt).toContain('body text');
    expect(prompt).toContain('OUR PR BODY');
  });

  it('states the corpus is a baseline the artifact may beat, not a target to imitate', () => {
    // A lens told to imitate would reward "the issue has been successfully resolved",
    // which is the worst habit in the corpus.
    expect(prompt).toMatch(/baseline, NOT a target/);
    expect(prompt).toMatch(/If ours is better, say so and do not invent a/);
  });

  it('asks the one question that separates evidence from assertion', () => {
    expect(prompt).toMatch(/fail against the unfixed code, or merely claim tests were added/);
    expect(prompt).toMatch(/blast radius/);
    expect(prompt).toMatch(/own confidence rather than about the code/);
  });

  it('names itself as the member, so its findings reconcile with the other lenses', () => {
    expect(prompt).toContain(`"member": "${BAR_LENS_NAME}"`);
  });
});

describe('measured test-count reconciliation', () => {
  const diff = [
    '--- a/test/money.test.js',
    '+++ b/test/money.test.js',
    "+test('rounds to the nearest cent', () => {",
    "+  assert.equal(millicentsToCents(1500), 2);",
    "+test('a half-cent rounds away from zero', () => {",
    "-test('an old removed case', () => {",
    " test('a context line nobody added', () => {",
  ].join('\n');

  it('counts only ADDED test blocks, from the diff rather than from prose', () => {
    // The lens's one verified finding was arithmetic, and counting occurrences in text
    // is the least reliable thing a model does. Compute it, then ask for an explanation.
    expect(countTestBlocks(diff)).toBe(2);
    expect(countTestBlocks('')).toBe(0);
  });

  it('reads the pass total the body claims', () => {
    expect(parseClaimedTestCount('- `npm test` — 6 passed, 0 failed.')).toBe(6);
    expect(parseClaimedTestCount('8 tests passing')).toBe(8);
    expect(parseClaimedTestCount('no countable claim here')).toBeUndefined();
  });

  it('states the discrepancy as a computed fact when the numbers disagree', () => {
    const prompt = buildBarLensPrompt({
      brief: '`npm test` — 6 passed, 0 failed.', diffSummary: diff, changedLines: 40, corpus,
    });
    expect(prompt).toContain('MEASURED');
    expect(prompt).toMatch(/adds 2 test/);
    expect(prompt).toMatch(/claims 6 passed/);
    expect(prompt).toMatch(/do NOT reconcile/);
  });

  it('says so plainly when they do reconcile, rather than inviting a fault', () => {
    const prompt = buildBarLensPrompt({
      brief: '`npm test` — 2 passed.', diffSummary: diff, changedLines: 40, corpus,
    });
    expect(prompt).toMatch(/Those reconcile\./);
  });
});

describe('loadCorpus', () => {
  it('degrades to undefined rather than throwing when the corpus is missing', () => {
    // A missing corpus must mean "this lens does not run", never a crashed round.
    expect(loadCorpus('C:/dev/_fdloop/out/definitely-not-here.json')).toBeUndefined();
  });

  it('reads the real corpus built from merged agent PRs', () => {
    const real = loadCorpus('C:/dev/_fdloop/out/agent-pr-corpus.json');
    expect(real).toBeDefined();
    expect(real!.corpus.length).toBeGreaterThan(5);
    expect(real!.corpus.every((e) => e.body.length > 0)).toBe(true);
  });
});
