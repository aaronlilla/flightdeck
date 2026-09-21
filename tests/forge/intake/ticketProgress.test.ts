/**
 * The goal audit and the ticket's own progress notes. The specimens that matter are the
 * refusals: a goal that never passes must park rather than build, and a parked ticket
 * must say why on the board, because a stall that produces silence is the failure this
 * whole pipeline exists to remove.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  auditGoal, goalAuditPrompt, parseGoalAudit, postProgress, progressComment,
  type GoalAudit, type ProgressDeps, type ProgressStage,
} from '../../../src/forge/intake/ticketProgress.ts';

function audit(over: Partial<GoalAudit> = {}): GoalAudit {
  return { verdict: 'ok', gap: '', why: 'it covers the ticket', ...over };
}

describe('auditGoal', () => {
  it('passes a goal its critic approves on the first round', async () => {
    const result = await auditGoal({
      write: async () => 'fix the balance refresh on the deposit screen',
      review: async () => audit(),
      maxRounds: 3,
    });
    expect(result).toEqual({ ok: true, goal: 'fix the balance refresh on the deposit screen', rounds: 1 });
  });

  it('rewrites against the named gap until the audit passes', async () => {
    const gaps: (string | undefined)[] = [];
    let round = 0;
    const result = await auditGoal({
      write: async ({ audit: a }) => { gaps.push(a?.gap); round += 1; return `goal ${round}`; },
      review: async ({ round: r }) => (r < 3
        ? audit({ verdict: 'adjust', gap: `missing piece ${r}` })
        : audit()),
      maxRounds: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.goal).toBe('goal 3');
    expect(gaps).toEqual([undefined, 'missing piece 1', 'missing piece 2']);
  });

  it('parks rather than building against a goal that never passes', async () => {
    const result = await auditGoal({
      write: async () => 'rewrite the whole wallet',
      review: async () => audit({ verdict: 'adjust', gap: 'the ticket only asks about one screen' }),
      maxRounds: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/did not pass its audit in 2 rounds/);
      expect(result.reason).toMatch(/only asks about one screen/);
      expect(result.bestGoal).toBe('rewrite the whole wallet');
    }
  });

  it('treats an unreadable audit as a failure, never as a pass', async () => {
    // Building against an unreviewed goal is exactly what this stage prevents.
    const result = await auditGoal({
      write: async () => 'a goal',
      review: async () => null,
      maxRounds: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/shape nothing can read/);
  });

  it('reports an empty goal and a thrown writer', async () => {
    const empty = await auditGoal({ write: async () => '  ', review: async () => audit(), maxRounds: 2 });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toMatch(/came back empty/);

    const threw = await auditGoal({
      write: async () => { throw new Error('model timeout'); }, review: async () => audit(), maxRounds: 2,
    });
    if (!threw.ok) expect(threw.reason).toMatch(/writing the goal failed on round 1: model timeout/);
  });
});

describe('parseGoalAudit', () => {
  it('reads the three lines', () => {
    expect(parseGoalAudit('VERDICT: adjust\nGAP: does not touch withdrawals\nWHY: the ticket names both')).toEqual({
      verdict: 'adjust', gap: 'does not touch withdrawals', why: 'the ticket names both',
    });
  });

  it('reads none as no gap', () => {
    expect(parseGoalAudit('VERDICT: ok\nGAP: none\nWHY: covers it')?.gap).toBe('');
  });

  it('returns null without a readable verdict', () => {
    expect(parseGoalAudit('looks fine')).toBeNull();
    expect(parseGoalAudit('VERDICT: 7/10')).toBeNull();
  });
});

describe('goalAuditPrompt', () => {
  const prompt = goalAuditPrompt({ ticket: 'BBZ-9', ticketText: 'TICKET TEXT', goal: 'GOAL TEXT' });

  it('carries both halves and asks the one question', () => {
    expect(prompt).toContain('TICKET TEXT');
    expect(prompt).toContain('GOAL TEXT');
    expect(prompt).toMatch(/would the ticket be satisfied/);
    expect(prompt).toContain('VERDICT: ok | adjust');
  });
});

describe('progressComment', () => {
  it('says what landed when it merged', () => {
    expect(progressComment({ ticket: 'BBZ-9', stage: 'merged', prUrl: 'https://x/pr/1' })).toBe('Merged, https://x/pr/1.');
  });

  it('always says why a ticket is parked', () => {
    expect(progressComment({ ticket: 'BBZ-9', stage: 'parked', reason: 'waiting on the BIN rows' }))
      .toBe('Parked this for now: waiting on the BIN rows');
  });

  it('says something actionable even when nobody recorded a reason', () => {
    // Silence is the failure being removed here, so a missing reason still gets a comment.
    const text = progressComment({ ticket: 'BBZ-9', stage: 'parked' });
    expect(text).toMatch(/no reason was recorded/);
  });

  it('says plainly when a repo is not ours to merge', () => {
    expect(progressComment({ ticket: 'BBZ-9', stage: 'handed-over', reason: 'controlled code, Joe merges it', prUrl: 'https://x/pr/2' }))
      .toBe('PR is up at https://x/pr/2 and needs a review before it can land: controlled code, Joe merges it');
  });

  it('stays quiet on the noisy stages', () => {
    expect(progressComment({ ticket: 'BBZ-9', stage: 'planning' })).toBeNull();
    expect(progressComment({ ticket: 'BBZ-9', stage: 'building' })).toBeNull();
    expect(progressComment({ ticket: 'BBZ-9', stage: 'review' })).toBeNull();
  });

  it('never describes itself as automated and carries no scaffolding', () => {
    const stages: ProgressStage[] = ['claimed', 'merged', 'parked', 'handed-over'];
    for (const stage of stages) {
      const text = progressComment({ ticket: 'BBZ-9', stage, reason: 'a reason', prUrl: 'https://x/pr/1' }) ?? '';
      expect(text).not.toMatch(/\b(automated|bot|as an ai|agent)\b/i);
      expect(text).not.toContain('**');
      expect(text).not.toMatch(/[—–]/);
    }
  });
});

describe('postProgress', () => {
  function deps(over: Partial<ProgressDeps> = {}): ProgressDeps & { posts: string[]; rows: Record<string, unknown>[] } {
    const posts: string[] = [];
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    return {
      post: async (_t, body) => { posts.push(body); return { ok: true }; },
      gate: () => null,
      alreadyPosted: (t, s) => seen.has(`${t}:${s}`),
      remember: (t, s) => { seen.add(`${t}:${s}`); },
      journal: { append: (row) => { rows.push(row); } },
      posts,
      rows,
      ...over,
    };
  }

  it('posts a stage once and never twice', async () => {
    const d = deps();
    expect(await postProgress({ ticket: 'BBZ-9', stage: 'merged' }, d)).toBe('posted');
    expect(await postProgress({ ticket: 'BBZ-9', stage: 'merged' }, d)).toBe('duplicate');
    expect(d.posts).toEqual(['Merged.']);
  });

  it('skips a stage with nothing worth saying', async () => {
    const d = deps();
    expect(await postProgress({ ticket: 'BBZ-9', stage: 'planning' }, d)).toBe('skipped');
    expect(d.posts).toEqual([]);
  });

  it('journals a refusal rather than throwing, so a lost comment cannot lose the merge', async () => {
    const d = deps({ post: async () => ({ ok: false, body: 'readability refused this comment' }) });
    expect(await postProgress({ ticket: 'BBZ-9', stage: 'merged' }, d)).toBe('refused');
    expect(d.rows.at(-1)).toMatchObject({ event: 'progress.refused', ticket: 'BBZ-9', stage: 'merged' });
  });

  it('never posts when the gate refuses', async () => {
    const post = vi.fn();
    const d = deps({ gate: () => 'over the word ceiling', post });
    expect(await postProgress({ ticket: 'BBZ-9', stage: 'parked', reason: 'x' }, d)).toBe('refused');
    expect(post).not.toHaveBeenCalled();
  });
});
