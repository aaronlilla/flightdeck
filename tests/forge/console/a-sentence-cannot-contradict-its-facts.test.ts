import { describe, expect, it } from 'vitest';

import { plainForQueueItem } from '../../../src/forge/console/plain.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

/**
 * A sentence on the board never asks for something its own facts rule out.
 *
 * Aaron, 2026-09-13: "the console constantly has stale or wrong or useless information."
 * The instance that started this was not stale data at all. The lane carried a pull
 * request reading `closed: true` and a mergeability verdict reading "closed without
 * merging", and the sentence beside both of them said "Draft PR 206 waiting for your
 * merge". The work had landed on main hours earlier.
 *
 * The cause was a merge of the fresh reading onto the stored one that carried two fields
 * by name and dropped the third. So the rule below is written against the OUTPUT rather
 * than against that merge: whatever fields exist now or later, a sentence that asks for a
 * merge has to be a sentence whose pull request can still be merged.
 *
 * Every combination is enumerated rather than sampled, so a new state cannot slip through
 * the gap between the cases somebody thought to write.
 */

const ASKS_FOR_A_MERGE = /waiting for your merge|waits for .* to land it|merge it/i;

function item(pr: Partial<NonNullable<QueueItem['pr']>>, state: QueueItem['state'] = 'review'): QueueItem {
  return {
    id: 'Q-1', source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: 'owner/name',
    briefPath: null, branch: 'feature/abc-1', worktreePath: null, base: 'develop',
    state, reason: null, runKey: 'r-1', journalIds: [], createdAt: 1, updatedAt: 1,
    pr: { no: 206, url: 'https://example.test/206', files: 1, add: 1, del: 0, draft: true, ...pr },
  } as unknown as QueueItem;
}

describe('a board sentence against the pull request it describes', () => {
  for (const state of ['review', 'done'] as const) {
    it(`never asks for a merge on a closed pull request (${state})`, () => {
      const said = plainForQueueItem(item({ closed: true, merged: false }, state), null, null);
      expect(said, 'no sentence at all').toBeTruthy();
      expect(said, `"${said}" asks for a merge on a closed pull request`).not.toMatch(ASKS_FOR_A_MERGE);
      expect(said).toMatch(/closed without merging/i);
    });

    it(`never asks for a merge on a merged pull request (${state})`, () => {
      const said = plainForQueueItem(item({ merged: true }, state), null, null);
      expect(said, `"${said}" asks for a merge on a merged pull request`).not.toMatch(ASKS_FOR_A_MERGE);
    });
  }

  it('does ask for a merge on one that is open and unmerged, which is the whole point', () => {
    const said = plainForQueueItem(item({ merged: false, closed: false }), null, null);
    expect(said).toMatch(ASKS_FOR_A_MERGE);
  });

  // Closed outranks every other fact. A closed pull request with green checks and a
  // passing review is still closed, and each of those clauses reads like an invitation.
  it('keeps closed above the checks and the review verdict', () => {
    const said = plainForQueueItem(item({ closed: true, merged: false, checks: 'success' }), { verdict: 'PASS', reviewed: 4, total: 4 }, null);
    expect(said).not.toMatch(ASKS_FOR_A_MERGE);
  });

  // A repository somebody else lands says who, and that is still asking for a merge --
  // from them. A closed pull request is not waiting on anybody.
  it('does not send somebody else to land a closed pull request', () => {
    const said = plainForQueueItem(item({ closed: true, merged: false }), null, 'a-teammate');
    expect(said).not.toMatch(ASKS_FOR_A_MERGE);
  });
});
