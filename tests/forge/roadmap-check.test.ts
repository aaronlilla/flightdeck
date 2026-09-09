import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { goalParagraph, pinnedGoalHash, runRoadmapCheck, type GhPrInfo } from '../../src/forge/roadmap-check.js';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const GOAL_PARAGRAPH = 'Flightdeck does the thing.';
const GOAL_HASH = sha256(GOAL_PARAGRAPH);

function roadmapText(opts: {
  goalHash?: string;
  itemsExtra?: string;
} = {}): string {
  const hashLine = opts.goalHash === undefined ? '' : `\n<!-- goal-sha256: ${opts.goalHash} -->\n`;
  return [
    '# Roadmap',
    '',
    '## The goal',
    '',
    GOAL_PARAGRAPH,
    hashLine,
    '## Items',
    '',
    '| id | delivers | serves | status | pr | proof |',
    '| --- | --- | --- | --- | --- | --- |',
    '| R-01 | thing one | queue | planned |  |  |',
    '| R-02 | thing two | queue | planned |  |  |',
    opts.itemsExtra ?? '',
  ].join('\n');
}

function pr(overrides: Partial<GhPrInfo>): GhPrInfo {
  return { number: 1, body: 'fixes R-01', state: 'MERGED', mergedAt: '2026-01-01', ...overrides };
}

describe('goalParagraph / pinnedGoalHash', () => {
  it('extracts the goal section text with the comment stripped', () => {
    const text = roadmapText({ goalHash: GOAL_HASH });
    expect(goalParagraph(text)).toBe(GOAL_PARAGRAPH);
    expect(pinnedGoalHash(text)).toBe(GOAL_HASH);
  });
});

describe('runRoadmapCheck: goal hash', () => {
  it('is clean when the pinned hash matches the goal paragraph', async () => {
    const result = await runRoadmapCheck({ roadmapText: roadmapText({ goalHash: GOAL_HASH }), listPrs: async () => [] });
    expect(result.failures).toEqual([]);
  });

  it('fails when the goal paragraph has drifted from its pinned hash', async () => {
    const result = await runRoadmapCheck({
      roadmapText: roadmapText({ goalHash: sha256('a different paragraph entirely') }),
      listPrs: async () => [],
    });
    expect(result.failures.some((f) => f.includes('goal-sha256'))).toBe(true);
  });

  it('fails when the goal section carries no goal-sha256 comment at all', async () => {
    const result = await runRoadmapCheck({ roadmapText: roadmapText(), listPrs: async () => [] });
    expect(result.failures.some((f) => f.includes('goal-sha256'))).toBe(true);
  });
});

describe('runRoadmapCheck: done rows need a merged pr', () => {
  it('fails a done row with an empty pr cell', async () => {
    const text = roadmapText({
      goalHash: GOAL_HASH,
      itemsExtra: '| R-03 | thing three | queue | done |  |  |',
    });
    const result = await runRoadmapCheck({ roadmapText: text, listPrs: async () => [] });
    expect(result.failures.some((f) => f.includes('R-03') && f.includes('empty'))).toBe(true);
  });

  it('fails a done row whose pr cell names a PR that is not merged', async () => {
    const text = roadmapText({
      goalHash: GOAL_HASH,
      itemsExtra: '| R-03 | thing three | queue | done | #7 |  |',
    });
    const result = await runRoadmapCheck({
      roadmapText: text,
      listPrs: async () => [pr({ number: 7, state: 'OPEN', mergedAt: null })],
    });
    expect(result.failures.some((f) => f.includes('R-03') && f.includes('not merged'))).toBe(true);
  });

  it('passes a done row whose pr cell names a merged PR', async () => {
    const text = roadmapText({
      goalHash: GOAL_HASH,
      itemsExtra: '| R-03 | thing three | queue | done | #7 |  |',
    });
    const result = await runRoadmapCheck({
      roadmapText: text,
      listPrs: async () => [pr({ number: 7, state: 'MERGED', mergedAt: '2026-01-01' })],
    });
    expect(result.failures).toEqual([]);
  });
});

describe('runRoadmapCheck: pr cells must name a real PR', () => {
  it('fails a pr cell naming a PR gh does not know about', async () => {
    const text = roadmapText({
      goalHash: GOAL_HASH,
      itemsExtra: '| R-03 | thing three | queue | running | #99 |  |',
    });
    const result = await runRoadmapCheck({ roadmapText: text, listPrs: async () => [pr({ number: 1 })] });
    expect(result.failures.some((f) => f.includes('R-03') && f.includes('#99'))).toBe(true);
  });

  it('is silent on a pr cell that names no PR number ("this PR", a link, empty)', async () => {
    const text = roadmapText({
      goalHash: GOAL_HASH,
      itemsExtra: '| R-03 | thing three | queue | running | this PR |  |',
    });
    const result = await runRoadmapCheck({ roadmapText: text, listPrs: async () => [] });
    expect(result.failures).toEqual([]);
  });
});

describe('runRoadmapCheck: open PRs must cite an R-id', () => {
  it('fails an open PR whose body cites no R-nn id', async () => {
    const result = await runRoadmapCheck({
      roadmapText: roadmapText({ goalHash: GOAL_HASH }),
      listPrs: async () => [pr({ number: 5, state: 'OPEN', mergedAt: null, body: 'just a fix, no ticket' })],
    });
    expect(result.failures.some((f) => f.includes('#5') && f.includes('no R-nn id'))).toBe(true);
  });

  it('is silent on a closed (non-open) PR with no R-id in its body', async () => {
    const result = await runRoadmapCheck({
      roadmapText: roadmapText({ goalHash: GOAL_HASH }),
      listPrs: async () => [pr({ number: 5, state: 'CLOSED', mergedAt: null, body: 'abandoned' })],
    });
    expect(result.failures).toEqual([]);
  });
});

describe('runRoadmapCheck: gh unreachable', () => {
  it('skips every gh-dependent check but still runs the local ones', async () => {
    const text = roadmapText({ goalHash: sha256('drifted') });
    const result = await runRoadmapCheck({ roadmapText: text, listPrs: async () => null });
    expect(result.ghSkipped).toBe(true);
    expect(result.failures.some((f) => f.includes('goal-sha256'))).toBe(true);
  });

  it('never fails purely because gh was refused, when the local checks are clean', async () => {
    const result = await runRoadmapCheck({ roadmapText: roadmapText({ goalHash: GOAL_HASH }), listPrs: async () => null });
    expect(result.failures).toEqual([]);
    expect(result.ghSkipped).toBe(true);
  });
});
