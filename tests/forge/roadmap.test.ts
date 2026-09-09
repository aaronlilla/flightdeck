import { describe, expect, it } from 'vitest';

import { parseRoadmapItems, roadmapIdOpen } from '../../src/forge/roadmap.js';

const TABLE = [
  '## Items',
  '',
  '| id | delivers | serves | status | pr | proof |',
  '| --- | --- | --- | --- | --- | --- |',
  '| R-01 | thing one | queue | done | owner/repo#1 | link |',
  '| R-02 | thing two | queue | planned |  |  |',
  '| R-03 | thing three | queue | running | owner/repo#3 |  |',
].join('\n');

describe('parseRoadmapItems', () => {
  it('parses each R-nn row, skipping the header and separator rows', () => {
    const items = parseRoadmapItems(TABLE);
    expect(items).toEqual([
      { id: 'R-01', status: 'done', pr: 'owner/repo#1' },
      { id: 'R-02', status: 'planned', pr: '' },
      { id: 'R-03', status: 'running', pr: 'owner/repo#3' },
    ]);
  });
});

describe('roadmapIdOpen', () => {
  it('is false for a row marked done', () => {
    expect(roadmapIdOpen(TABLE, 'R-01')).toBe(false);
  });

  it('is true for a planned or running row', () => {
    expect(roadmapIdOpen(TABLE, 'R-02')).toBe(true);
    expect(roadmapIdOpen(TABLE, 'R-03')).toBe(true);
  });

  it('is false for an id the table never names', () => {
    expect(roadmapIdOpen(TABLE, 'R-99')).toBe(false);
  });
});
