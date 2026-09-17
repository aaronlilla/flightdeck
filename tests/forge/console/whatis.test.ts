import { describe, expect, it } from 'vitest';

import {
  agoWords, classifyRef, fromBoard, fromJira, mergeTicket, notFound, prNumberFrom,
  pullRequestFromBoard, runFromBoard, titleWithoutRef,
} from '../../../src/forge/console/whatis.js';
import type { Lane, QueueItem } from '../../../src/shared/console-model.js';

/**
 * Aaron, 2026-09-12: "when i hover over an item that has an acronym, like a bbz ticket
 * number, i should be able to see full detail of the ticket or whatever it is, ticket or
 * not."
 *
 * The board is full of short references the reader is expected to already know. Linking
 * them out helps only if you are willing to leave the page; this answers in place.
 */

function lane(patch: Partial<Lane> = {}): Lane {
  return {
    id: 'queue-BBZ-169-Q-1', ticket: 'BBZ-169', title: 'Fix the drop-down', state: 'unverified',
    plain: 'Council passed with notes; ready to merge.', sourceUrl: 'https://jira.test/browse/BBZ-169',
    pr: null, repo: 'o/r', retiredAt: null, live: { alive: false, pid: null, lastEventAt: 0, checkedAt: 0 },
    ...patch,
  } as unknown as Lane;
}

function item(patch: Partial<QueueItem> = {}): QueueItem {
  return { id: 'Q-1', ticket: 'BBZ-169', state: 'review', repo: 'o/r', pr: null, title: null, ...patch } as unknown as QueueItem;
}

describe('classifying what was hovered', () => {
  it('knows a ticket key', () => {
    expect(classifyRef('BBZ-169')).toBe('ticket');
  });

  it('knows a pull request, in every form the board writes it', () => {
    for (const ref of ['#159', 'PR #159', 'pull request #159', 'draft PR #159']) {
      expect(classifyRef(ref), ref).toBe('pull-request');
    }
  });

  it('treats anything else with words in it as a run', () => {
    expect(classifyRef('2026-09-09-readable-pr-rule')).toBe('run');
  });

  it('reads the number out of every pull request form', () => {
    expect(prNumberFrom('draft PR #159')).toBe(159);
    expect(prNumberFrom('#159')).toBe(159);
    expect(prNumberFrom('BBZ-169')).toBeNull();
  });
});

describe('what the board knows about a ticket', () => {
  it('answers with where the work stands here', () => {
    const out = fromBoard('BBZ-169', [lane()], [item()]);
    expect(out?.title).toBe('Fix the drop-down');
    expect(out?.fields).toContainEqual({ label: 'On the board', value: 'unverified' });
    expect(out?.fields).toContainEqual({ label: 'In the queue', value: 'review' });
  });

  it('carries the pull request and its checks when there is one', () => {
    const withPr = lane({ pr: { no: 159, url: 'u', draft: true, checks: 'success', verdict: 'pass' } as Lane['pr'] });
    const out = fromBoard('BBZ-169', [withPr], []);
    expect(out?.fields).toContainEqual({ label: 'Pull request', value: '#159 (draft)' });
    expect(out?.fields).toContainEqual({ label: 'Checks', value: 'success' });
  });

  it('answers null for a ticket nothing here is working', () => {
    expect(fromBoard('BBZ-999', [lane()], [item()])).toBeNull();
  });
});

describe('what the board knows about a pull request', () => {
  it('answers with its state and its diff', () => {
    const withPr = lane({ pr: { no: 159, url: 'u', draft: false, merged: false, checks: 'success', files: 7, add: 433, del: 45 } as Lane['pr'] });
    const out = pullRequestFromBoard(159, [withPr], []);
    expect(out?.state).toBe('open');
    expect(out?.fields).toContainEqual({ label: 'Diff', value: '7 files, +433 −45' });
    expect(out?.fields).toContainEqual({ label: 'Ticket', value: 'BBZ-169' });
  });

  it('says merged when it is', () => {
    const merged = lane({ pr: { no: 159, url: 'u', draft: false, merged: true } as Lane['pr'] });
    expect(pullRequestFromBoard(159, [merged], [])?.state).toBe('merged');
  });

  it('answers null for one nothing here tracks', () => {
    expect(pullRequestFromBoard(999, [lane()], [])).toBeNull();
  });
});

describe('what the board knows about a run', () => {
  it('answers with its state and whether anything is running', () => {
    const out = runFromBoard('queue-BBZ-169-Q-1', [lane()]);
    expect(out?.state).toBe('unverified');
    expect(out?.fields).toContainEqual({ label: 'Process', value: 'not running' });
  });

  it('finds one by the name a person reads, not only by its id', () => {
    expect(runFromBoard('Fix the drop-down', [lane()])?.kind).toBe('run');
  });
});

describe('what Jira says', () => {
  const issue = {
    summary: 'Fix player card drop-down persistence', status: 'In Progress', assignee: 'Aaron Lilla',
    issueType: 'Bug', priority: 'High', updated: '2026-09-11', description: 'The drop-down loses its selection.',
  };

  it('reads as the same shape every other source answers in', () => {
    const out = fromJira('BBZ-169', issue, 'https://jira.test');
    expect(out.title).toBe('Fix player card drop-down persistence');
    expect(out.state).toBe('In Progress');
    expect(out.body).toContain('loses its selection');
    expect(out.url).toBe('https://jira.test/browse/BBZ-169');
  });

  it('leaves out a field the issue does not carry', () => {
    const bare = fromJira('BBZ-1', { ...issue, assignee: null, priority: null }, null);
    expect(bare.fields.map((field) => field.label)).toEqual(['Type', 'Updated']);
    expect(bare.url).toBeNull();
  });
});

describe('merging the two halves', () => {
  it('keeps Jira as the authority on the ticket and the board on what is being done', () => {
    const jira = fromJira('BBZ-169', {
      summary: 'Fix the drop-down', status: 'In Progress', assignee: 'Aaron Lilla',
      issueType: 'Bug', priority: null, updated: null, description: 'Long description.',
    }, 'https://jira.test');
    const out = mergeTicket(jira, fromBoard('BBZ-169', [lane()], [item()]));
    expect(out.state).toBe('In Progress');
    expect(out.fields).toContainEqual({ label: 'Assignee', value: 'Aaron Lilla' });
    expect(out.fields).toContainEqual({ label: 'In the queue', value: 'review' });
  });

  it('never lets the board overwrite a field Jira already answered', () => {
    const jira = fromJira('BBZ-169', {
      summary: 'From Jira', status: 'Done', assignee: null, issueType: 'Bug',
      priority: null, updated: null, description: null,
    }, null);
    const board = fromBoard('BBZ-169', [lane({ title: 'From the board' })], []);
    expect(mergeTicket(jira, board).title).toBe('From Jira');
  });

  it('is only the Jira half when the board knows nothing', () => {
    const jira = fromJira('BBZ-1', {
      summary: 's', status: 'To Do', assignee: null, issueType: null,
      priority: null, updated: null, description: null,
    }, null);
    expect(mergeTicket(jira, null)).toEqual(jira);
  });
});

describe('a reference that resolves to nothing', () => {
  it('says so rather than showing a blank card', () => {
    const out = notFound('BBZ-404');
    expect(out.kind).toBe('unknown');
    expect(out.body).toContain('Nothing on the board or in Jira answers to BBZ-404');
  });
});

/**
 * Aaron, 2026-09-12: "the text looks terrible." Jira answers an ISO stamp
 * (`2026-09-11T16:24:51.519-0700`), which is a machine string and reads as one on a card
 * somebody is glancing at.
 */
describe('when it was last touched', () => {
  const NOW = Date.parse('2026-09-12T18:00:00Z');
  const ago = (iso: string) => agoWords(iso, NOW);

  it('says it in words for anything recent', () => {
    expect(ago('2026-09-12T17:58:00Z')).toBe('2 min ago');
    expect(ago('2026-09-12T17:00:00Z')).toBe('an hour ago');
    expect(ago('2026-09-12T12:00:00Z')).toBe('6 hours ago');
    expect(ago('2026-09-11T18:00:00Z')).toBe('yesterday');
    expect(ago('2026-09-09T18:00:00Z')).toBe('3 days ago');
  });

  it('keeps the date once "n days ago" stops being useful', () => {
    expect(ago('2026-08-20T18:00:00Z')).toBe('2026-08-20');
  });

  it('leaves a stamp it cannot read exactly as it came', () => {
    expect(ago('not a date')).toBe('not a date');
  });

  it('reaches the field a person reads', () => {
    const out = fromJira('BBZ-1', {
      summary: 's', status: 'To Do', assignee: null, issueType: null,
      priority: null, updated: '2026-09-11T18:00:00Z', description: null,
    }, null, NOW);
    expect(out.fields).toContainEqual({ label: 'Updated', value: 'yesterday' });
  });
});

/** A title carrying its own key reads as a stutter under a heading that already shows it. */
describe('a title that repeats its own key', () => {
  it('drops a trailing key in brackets', () => {
    expect(titleWithoutRef('Fix the drop-down (BBZ-169)', 'BBZ-169')).toBe('Fix the drop-down');
  });

  it('drops a trailing key with no brackets', () => {
    expect(titleWithoutRef('Fix the drop-down BBZ-169', 'BBZ-169')).toBe('Fix the drop-down');
  });

  it('leaves a key that belongs to a different ticket alone', () => {
    expect(titleWithoutRef('Blocked on BBZ-123', 'BBZ-169')).toBe('Blocked on BBZ-123');
  });

  it('leaves a key mentioned mid-sentence alone', () => {
    expect(titleWithoutRef('BBZ-169 blocks the release', 'BBZ-169')).toBe('BBZ-169 blocks the release');
  });

  it('keeps a title that is nothing but its key', () => {
    expect(titleWithoutRef('BBZ-169', 'BBZ-169')).toBe('BBZ-169');
  });

  it('passes a missing title straight through', () => {
    expect(titleWithoutRef(null, 'BBZ-169')).toBeNull();
  });
});
