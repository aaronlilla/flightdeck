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

  it('lists each commit as its own entry, off the real git log (verbose keeps the sha)', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'manual', ticket: null, verbose: true,
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

describe('computeLaneStory: plain mode (deliverable 9)', () => {
  it('a commit entry drops the sha in plain mode, keeps it in verbose', () => {
    const input = {
      id: 'alpha', title: null, kind: 'manual' as const, ticket: null,
      events: [ev({ event: 'run.started', run: 'alpha', at: 1_000 })],
      gitCommits: [{ sha: '3982779abcdef', subject: 'wire the merge chip', at: 2_000 }],
    };
    const plain = computeLaneStory(input);
    expect(plain.entries.map((e) => e.text)).toContain('Committed: wire the merge chip');

    const verbose = computeLaneStory({ ...input, verbose: true });
    expect(verbose.entries.map((e) => e.text)).toContain('Change 3982779: wire the merge chip');
  });

  it('a park reason goes through humanizeParkReason, verbose keeps the raw reason', () => {
    const input = {
      id: 'alpha', title: null, kind: 'manual' as const, ticket: null,
      events: [
        ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
        ev({ event: 'run.parked', run: 'alpha', at: 2_000, reason: 'parking on a1b2c3d4e5f6a7b8: continue?' }),
      ],
    };
    const plain = computeLaneStory(input);
    expect(plain.entries.map((e) => e.text)).toContain('Parked: Asked you: continue?');

    const verbose = computeLaneStory({ ...input, verbose: true });
    expect(verbose.entries.map((e) => e.text).some((t) => t.includes('a1b2c3d4e5f6a7b8'))).toBe(true);
  });

  it('never leaves a machine id in any plain-mode entry text', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'chain', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
        ev({
          event: 'run.killed', run: 'alpha', at: 2_000,
          reason: 'blocked behind queue-BBZ-1 at 88d44ec96baea849f7c1e8c0a1b2c3d4e5f6a7b8',
        }),
      ],
    });
    for (const entry of story.entries) {
      expect(entry.text).not.toMatch(/queue-|\b[0-9a-f]{40}\b/i);
    }
  });

  it('collapses identical consecutive entries into one with a repeat count', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'chain', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
        ev({ event: 'run.parked', run: 'alpha', at: 2_000, reason: 'waiting on you' }),
        ev({ event: 'run.resumed', run: 'alpha', at: 3_000 }),
        ev({ event: 'ask.answered', run: 'alpha', at: 4_000, answer: 'same note' }),
        ev({ event: 'ask.answered', run: 'alpha', at: 5_000, answer: 'same note' }),
        ev({ event: 'ask.answered', run: 'alpha', at: 6_000, answer: 'same note' }),
      ],
    });
    const answerEntries = story.entries.filter((e) => e.text.startsWith('Answered by you'));
    expect(answerEntries).toHaveLength(1);
    expect(answerEntries[0]!.text).toBe('Answered by you: same note (x3)');
  });

  it('collapses a park/resume cycle repeated more than twice into one summary line', () => {
    const events: ForgeEvent[] = [ev({ event: 'run.started', run: 'alpha', at: 1_000 })];
    let at = 2_000;
    for (let i = 0; i < 4; i += 1) {
      events.push(ev({ event: 'run.parked', run: 'alpha', at, reason: `check ${i}` }));
      at += 500;
      events.push(ev({ event: 'run.resumed', run: 'alpha', at }));
      at += 500;
    }
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'chain', ticket: null, events,
    });
    const cycleLine = story.entries.find((e) => e.text.startsWith('Parked and resumed'));
    expect(cycleLine).toBeDefined();
    expect(cycleLine!.text).toContain('4 times');
    expect(cycleLine!.text).toContain('last reason: check 3');
    expect(story.entries.filter((e) => e.kind === 'resume')).toHaveLength(0);
  });

  // Item 5: a run.parked row whose own ask text happens to mention "warden" (a PR
  // about a warden.health fix, say) must not be misread as the warden's own park --
  // that call is decided by the event name or the reason's opening words, never by a
  // search through the whole reason body.
  it('a run.parked row is never mistaken for a warden park just because its own text mentions "warden"', () => {
    const reason = 'parking on 19a6c631cb7783d8: PR #39 (S-b9d39bae548707e0) is open, draft, and mergeable, '
      + 'with the warden.health dedupe fix and a new failing-then-passing test in tests/forge/warden-tick.test.ts.';
    const story = computeLaneStory({
      id: 'S-b9d39bae548707e0', title: null, kind: 'self', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'S-b9d39bae548707e0', at: 1_000 }),
        ev({ event: 'run.parked', run: 'S-b9d39bae548707e0', at: 2_000, reason }),
      ],
    });
    const parked = story.entries.find((e) => e.kind === 'park');
    expect(parked!.text.startsWith('Parked: Asked you:')).toBe(true);
    expect(parked!.text).not.toContain('Warden parked it');
    expect(parked!.text).not.toContain('parking on:');
    expect(parked!.text).toContain('PR #39 is open, draft, and mergeable');
  });

  it('a genuine warden park still reads "Warden parked it" off the event name', () => {
    const story = computeLaneStory({
      id: 'alpha', title: null, kind: 'chain', ticket: null,
      events: [
        ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
        ev({ event: 'warden.parked', run: 'alpha', at: 2_000, reason: 'stale-session: no tool call in 20 minutes' }),
      ],
    });
    const parked = story.entries.find((e) => e.kind === 'park');
    expect(parked!.text.startsWith('Warden parked it:')).toBe(true);
  });

  it('cuts a long "Asked you" line to 240 characters at a word boundary in plain mode, keeps it whole in verbose', () => {
    const question = `PR #39 is open, draft, and mergeable, with the warden.health dedupe fix and a new failing-then-passing test in tests/forge/warden-tick.test.ts. Locally: npx vitest run tests/forge/warden-tick.test.ts is 20/20, and npm run verify is 2147/2154 (the 7 failures are in cli.test.ts and sdkengine.test.ts, pre-existing, unrelated to this change).`;
    const reason = `parking on 19a6c631cb7783d8: ${question}`;
    const events: ForgeEvent[] = [
      ev({ event: 'run.started', run: 'alpha', at: 1_000 }),
      ev({ event: 'run.parked', run: 'alpha', at: 2_000, reason }),
    ];

    const plain = computeLaneStory({ id: 'alpha', title: null, kind: 'chain', ticket: null, events });
    const plainParked = plain.entries.find((e) => e.kind === 'park')!;
    expect(plainParked.text.length).toBeLessThanOrEqual(241);
    expect(plainParked.text.endsWith('…')).toBe(true);
    expect(plainParked.text).not.toContain('S-b9d39bae548707e0');

    const verbose = computeLaneStory({ id: 'alpha', title: null, kind: 'chain', ticket: null, events, verbose: true });
    const verboseParked = verbose.entries.find((e) => e.kind === 'park')!;
    expect(verboseParked.text).toContain(question);
    expect(verboseParked.text.endsWith('…')).toBe(false);
  });
});
