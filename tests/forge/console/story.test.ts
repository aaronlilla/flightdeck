/**
 * `computeLaneStory` (H1.6): a lane's whole record, in the order a person would tell
 * it, off the real journal rows for the run and its successors -- never a placeholder
 * for a milestone that has not happened yet.
 */
import { describe, expect, it } from 'vitest';

import { computeLaneStory } from '../../../src/forge/console/story.js';
import type { ForgeEvent } from '../../../src/forge/journal.js';

function ev(partial: Partial<ForgeEvent> & { event: string; at: number }): ForgeEvent {
  return { id: `${partial.event}-${partial.at}`, seq: 1, version: 1, actor: 'runner', ...partial } as ForgeEvent;
}

describe('computeLaneStory', () => {
  it('opens with the ticket queued line when there is a ticket', () => {
    const story = computeLaneStory({
      id: 'queue-BBZ-96', title: 'add the merge chip', kind: 'ticket',
      ticket: { key: 'BBZ-96', url: 'https://x.atlassian.net/browse/BBZ-96', summary: 'add the merge chip' },
      events: [ev({ event: 'run.started', run: 'queue-BBZ-96', at: 1_000 })],
      queueItem: {
        id: 'Q-1', source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n', briefPath: 'b.md',
        branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop', state: 'running', reason: null,
        runKey: 'queue-BBZ-96', pr: null, journalIds: [], createdAt: 500, updatedAt: 500,
      },
    });
    expect(story.entries[0]).toMatchObject({ kind: 'ticket', text: expect.stringContaining('Queued from Jira as BBZ-96 at') });
  });

  it('reports the branch and base off the queue item, once one is provisioned', () => {
    const story = computeLaneStory({
      id: 'queue-BBZ-96', title: 'add the merge chip', kind: 'ticket', ticket: null,
      events: [ev({ event: 'run.started', run: 'queue-BBZ-96', at: 1_000 })],
      queueItem: {
        id: 'Q-1', source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n', briefPath: 'b.md',
        branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop', state: 'running', reason: null,
        runKey: 'queue-BBZ-96', pr: null, journalIds: [], createdAt: 500, updatedAt: 500,
      },
    });
    expect(story.entries.map((e) => e.text)).toContain('Branch feature/bbz-96 off develop');
  });

  it('lists each commit as its own entry, off the real git log', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'manual', ticket: null,
      events: [ev({ event: 'run.started', run: 'alpha', at: 1_000 })],
      gitCommits: [{ sha: '3982779abc', subject: 'wire the merge chip', at: 2_000 }],
    });
    expect(story.entries.map((e) => e.text)).toContain('Change 3982779: wire the merge chip');
  });

  it('reports a draft PR opening, once the queue item carries one', () => {
    const story = computeLaneStory({
      id: 'queue-BBZ-96', title: null, kind: 'ticket', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'queue-BBZ-96', at: 1_000 }),
        ev({ event: 'queue.review', actor: 'queue', itemId: 'Q-1', at: 3_000 }),
      ],
      queueItem: {
        id: 'Q-1', source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n', briefPath: 'b.md',
        branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop', state: 'review', reason: null,
        runKey: 'queue-BBZ-96', pr: { no: 119, url: 'https://github.com/o/n/pull/119', files: 3, add: 10, del: 2, draft: true },
        journalIds: [], createdAt: 500, updatedAt: 3_000,
      },
    });
    expect(story.entries.map((e) => e.text)).toContain('Draft PR #119 opened');
  });

  it('reports the council verdict, its coverage and one sentence per finding', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'ticket', ticket: null,
      events: [ev({ event: 'run.started', run: 'alpha', at: 1_000 })],
      attestation: {
        repo: 'o/n', pr: 119, head: 'sha1', base: 'develop', round: 1, verdict: 'PASS WITH NOTES',
        decidingFindings: [{
          member: 'money-lens', file: 'a.ts', line: 12, claim: 'a rounding edge case is untested',
          failureScenario: 'x', severity: 'low', confidence: 'medium',
        }],
        lenses: [], judge: { model: 'sonnet-5', verdict: 'PASS WITH NOTES' }, ci: { runId: 'r1', headSha: 'sha1' },
        at: { value: 4_000, observed_at: 4_000 }, coverage: { total: 4, missing: [] },
      },
    });
    expect(story.entries.map((e) => e.text)).toContain('Council: PASS WITH NOTES, 4 of 4 reviewed, 1 note');
    expect(story.entries.map((e) => e.text)).toContain('Council note: a rounding edge case is untested');
  });

  it('walks parked -> answered -> resumed, each as its own sentence', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'manual', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
        ev({ event: 'run.parked', run: 'alpha', at: 2_000, reason: 'staging or dev?' }),
        ev({ event: 'ask.answered', run: 'alpha', at: 2_500, answer: 'dev' }),
        ev({ event: 'run.resumed', run: 'alpha', at: 2_600 }),
      ],
    });
    const texts = story.entries.map((e) => e.text);
    expect(texts).toContain('Parked: staging or dev?');
    expect(texts).toContain('Answered by you: dev');
    expect(texts).toContain('Resumed');
  });

  it('reports a kill with its reason', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'manual', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
        ev({ event: 'run.killed', run: 'alpha', at: 2_000, reason: 'runaway spend' }),
      ],
    });
    expect(story.entries.map((e) => e.text)).toContain('Killed by you: runaway spend');
  });

  it('reports a merge and the finished verdict, in time order', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'chain', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
        ev({ event: 'run.finished', run: 'alpha', at: 2_000, verdict: 'done' }),
        ev({ event: 'chain.merged', packetId: 'alpha', at: 3_000 }),
      ],
    });
    const texts = story.entries.map((e) => e.text);
    expect(texts.indexOf('Merged')).toBeGreaterThan(texts.indexOf('Ended: done'));
  });

  it('never invents a milestone that has not happened -- a run still mid-flight gets a short list', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'manual', ticket: null,
      events: [ev({ event: 'run.started', run: 'alpha', at: 1_000 })],
    });
    expect(story.entries).toHaveLength(1);
  });

  it('carries the brief excerpt, capped at 600 characters', () => {
    const long = `# heading\n\n${'x'.repeat(1_000)}`;
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'manual', ticket: null,
      events: [ev({ event: 'run.started', run: 'alpha', at: 1_000 })],
      briefPath: 'b.md', briefText: long,
    });
    expect(story.brief?.path).toBe('b.md');
    expect(story.brief?.excerpt.length).toBe(600);
  });
});
