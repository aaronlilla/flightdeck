import { describe, expect, it } from 'vitest';

import { appendProposedLine, citesRoadmapId, parseRoadmapItems, roadmapIdOpen } from '../../src/forge/roadmap.js';

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

describe('citesRoadmapId', () => {
  it('is true when the text names an R-nn id', () => {
    expect(citesRoadmapId('fixes R-04 off-roadmap parking')).toBe(true);
  });

  it('is false when the text names no id', () => {
    expect(citesRoadmapId('a queue item with no roadmap line')).toBe(false);
  });
});

describe('appendProposedLine', () => {
  it('adds a Proposed section when the file has none yet', () => {
    const text = '# Roadmap\n\n## Items\n\n| id |\n';
    const result = appendProposedLine(text, '- 2026-09-08: sig -- summary');
    expect(result).toBe('# Roadmap\n\n## Items\n\n| id |\n\n## Proposed\n\n- 2026-09-08: sig -- summary\n');
  });

  it('appends after the last existing line in an already-present Proposed section', () => {
    const text = [
      '# Roadmap', '', '## Proposed', '', '- 2026-09-07: old -- first finding', '',
      '## Items', '', '| id |',
    ].join('\n');
    const result = appendProposedLine(text, '- 2026-09-08: sig -- summary');
    expect(result).toBe([
      '# Roadmap', '', '## Proposed', '', '- 2026-09-07: old -- first finding',
      '- 2026-09-08: sig -- summary', '', '## Items', '', '| id |',
    ].join('\n'));
  });
});
