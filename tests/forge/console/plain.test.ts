/**
 * `plainStatus` (H1.2): one sentence a person can act on for every lane state, with no
 * run id, hop number or bare verdict word anywhere in it.
 */
import { describe, expect, it } from 'vitest';

import { plainForQueueItem, plainStatus, type PlainContext } from '../../../src/forge/console/plain.js';
import type { Lane, QueueItem } from '../../../src/shared/console-model.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'jira_BBZ-89_1788460932645', ticket: 'BBZ-89', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 43, stepTotal: 120, stepText: 'Bash',
    ctxTokens: 1_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: true, since: 44_640_000,
    startedAt: 0, endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null,
    ...extra,
  };
}

const context: PlainContext = { now: 44_640_000 };

describe('plainStatus', () => {
  it('running: names the model, the turn count and the last tool', () => {
    const text = plainStatus(lane({ state: 'running', model: 'sonnet-5', stepN: 43, stepText: 'Bash' }), context);
    expect(text).toContain('Sonnet');
    expect(text).toContain('43 turns in');
    expect(text).toContain('Bash');
    expect(text).not.toMatch(/jira_|queue-|hop \d/i);
  });

  it('review with a draft PR whose checks are green and the council cleared it: waits for Merge', () => {
    const text = plainStatus(lane({
      state: 'done',
      pr: { no: 119, url: 'https://github.com/o/n/pull/119', files: 3, add: 10, del: 2, draft: true, checks: 'success', verdict: 'PASS WITH NOTES', merged: false },
    }), context);
    expect(text).toBe('Draft PR #119 is open with checks green and the council\'s PASS WITH NOTES; waiting for your Merge.');
  });

  it('done and merged: names when, and the OTA outcome when it is known', () => {
    const text = plainStatus(lane({
      state: 'merged', since: 44_640_000 - 3 * 60_000,
      pr: { no: 119, url: 'https://x/pull/119', files: 1, add: 1, del: 0, draft: false, merged: true },
    }), context);
    expect(text).toMatch(/^Merged into develop at /);
  });

  it('parked on a question: leads with the question, trimmed to 90 characters', () => {
    const longQuestion = 'staging or dev, and should the migration run before or after the deploy window closes tonight?';
    const text = plainStatus(lane({ state: 'parked', question: { key: 'k1', text: longQuestion, opts: ['a', 'b'], askedAt: 1 } }), context);
    expect(text.startsWith('Waiting for your answer: ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual('Waiting for your answer: '.length + 90);
  });

  it('parked by the warden: names the reason and offers Resume', () => {
    const text = plainStatus(lane({ state: 'parked', reason: 'a build ran past the 120 s script budget', since: 44_640_000 - 60_000 }), context);
    expect(text).toContain('Parked by the warden');
    expect(text).toContain('Resume to continue');
    expect(text).toContain('a build ran past the 120 s script budget');
  });

  it('unverified with an open PR: says the checklist did not finish, and the council reviews it next', () => {
    const text = plainStatus(lane({
      state: 'unverified',
      pr: { no: 119, url: 'https://x/pull/119', files: 1, add: 1, del: 0, draft: true },
    }), context);
    expect(text).toBe('The session ended without finishing its checklist, but its PR #119 is open; the council reviews it next.');
  });

  it('killed: names who stopped it, when, and why', () => {
    const text = plainStatus(lane({ state: 'killed', reason: 'runaway spend', since: 44_640_000 - 2 * 60_000 }), context);
    expect(text).toContain('Stopped by you');
    expect(text).toContain('runaway spend');
  });

  it('blocked with a chain reason: names since when and the reason, never the word "blocked" alone', () => {
    const text = plainStatus(lane({ state: 'blocked', reason: 'base drift', kind: 'chain', since: 44_640_000 - 26 * 60 * 60_000 }), context);
    expect(text.startsWith('Blocked since ')).toBe(true);
    expect(text).toContain('base drift');
  });

  it('a finished probe: says it passed, with the time', () => {
    const text = plainStatus(lane({ state: 'done', kind: 'probe', pr: null }), context);
    expect(text).toContain('Probe passed at');
  });

  it('every state produces a non-empty sentence with no run id, hop number or bare verdict word', () => {
    const states: Lane['state'][] = ['running', 'handed-off', 'paused', 'parked', 'done', 'merged', 'blocked', 'exhausted', 'killed', 'unverified'];
    for (const state of states) {
      const text = plainStatus(lane({ state }), context);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/jira_BBZ-89_1788460932645|queue-BBZ-89|hop \d/i);
      expect(text.trim()).not.toMatch(/^(PASS|FAIL|FIX FIRST|PASS WITH NOTES|killed|done|parked)$/i);
    }
  });
});

function queueItem(extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'Q-1', source: 'ticket', input: 'BBZ-96', ticket: 'BBZ-96', repo: 'o/n',
    briefPath: null, branch: 'feature/bbz-96', worktreePath: 'w', base: 'develop',
    state: 'review', reason: null, runKey: 'queue-BBZ-96', pr: null, journalIds: [],
    createdAt: 1, updatedAt: 1,
    ...extra,
  };
}

describe('plainForQueueItem (H1.2 fix): the queue\'s own state and reason win over the run\'s own verdict', () => {
  it('review: reads the attestation verdict and coverage, and says checks are not read yet rather than pending', () => {
    const item = queueItem({
      state: 'review',
      pr: { no: 119, url: 'https://github.com/o/n/pull/119', files: 6, add: 360, del: 5, draft: true },
    });
    const text = plainForQueueItem(item, { verdict: 'PASS WITH NOTES', reviewed: 4, total: 4 });
    expect(text).toBe('In review: council PASS WITH NOTES, 4 of 4 reviewed; draft PR #119 is waiting for your Merge.');
    expect(text).not.toMatch(/pending/);
  });

  it('done with a merged PR: says merged, not the run\'s own unverified verdict', () => {
    const item = queueItem({
      state: 'done',
      pr: { no: 118, url: 'https://github.com/o/n/pull/118', files: 2, add: 10, del: 1, draft: false, merged: true },
    });
    expect(plainForQueueItem(item, null)).toContain('Merged');
  });

  it('done with an open draft the queue never merged: says the queue never merges on its own', () => {
    const item = queueItem({
      state: 'done',
      pr: { no: 118, url: 'https://github.com/o/n/pull/118', files: 2, add: 10, del: 1, draft: true, merged: false },
    });
    expect(plainForQueueItem(item, null)).toBe(
      'Draft PR #118 is open; the queue never merges on its own, so it is waiting for your Merge.',
    );
  });

  it('parked: the item\'s own reason, in words', () => {
    const item = queueItem({ state: 'parked', reason: 'overlaps BBZ-1 on src/wallet.ts' });
    expect(plainForQueueItem(item, null)).toBe('Parked: overlaps BBZ-1 on src/wallet.ts.');
  });

  it('every other queue state defers to the run-based sentence', () => {
    for (const state of ['queued', 'planning', 'running', 'failed'] as const) {
      expect(plainForQueueItem(queueItem({ state }), null)).toBeNull();
    }
  });
});

describe('the human-board fixture never leaks a run id, a successor id or a hop word into plain', () => {
  it('every plain sentence across a representative fixture is clean', async () => {
    const { humanBoardLanes } = await import('../../../src/console/fixtures/scenarios.js');
    for (const l of humanBoardLanes()) {
      expect(l.plain).not.toMatch(/queue-|jira_|forge-live|-\d+$/);
      expect(l.plain).not.toMatch(/\b[0-9a-f]{16}\b/i);
    }
  });
});

describe('running sentence never echoes a run id', () => {
  it('drops the successor id from the step text', async () => {
    const { plainStatus } = await import('../../../src/forge/console/plain.js');
    const lane = { state: 'running', model: 'sonnet-5', since: 1_000_000, stepN: 0, stepText: 'S-5226b2bfa2730dc8-3 running Bash' } as never;
    const text = plainStatus(lane, { now: 1_100_000 });
    expect(text).toMatch(/last did: Bash\.$/);
    expect(text).not.toMatch(/[0-9a-f]{8,}/);
  });
});
