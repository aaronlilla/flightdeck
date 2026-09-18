/**
 * The claim decision and the write order it performs. The ordering specimens matter more
 * than the parsing ones: a claim touches a shared board, and the failure everybody
 * notices is a ticket silently reassigned with no comment explaining why.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CLAIMS_PER_HOUR, CLAIMS_PER_PASS, claimBlocked, claimPrompt, parseClaim, performClaim,
  type ClaimDeps,
} from '../../../src/forge/intake/ticketClaim.ts';

const REPOS = ['BOLTBETZ-LLC/v2-React-Native', 'BOLTBETZ-LLC/BBManagementSystemV2'];

function deps(over: Partial<ClaimDeps> = {}): ClaimDeps & { rows: Record<string, unknown>[]; queued: string[] } {
  const rows: Record<string, unknown>[] = [];
  const queued: string[] = [];
  return {
    comment: async () => ({ ok: true, status: 201, id: '1' }),
    assign: async () => ({ ok: true, status: 204 }),
    enqueue: (ticket: string) => { queued.push(ticket); },
    operatorAccountId: 'acc-me',
    journal: { append: (row) => { rows.push(row); } },
    now: () => 1_000,
    rows,
    queued,
    ...over,
  };
}

describe('performClaim', () => {
  it('comments, then assigns, then enqueues, in that order', async () => {
    const order: string[] = [];
    const d = deps({
      comment: async () => { order.push('comment'); return { ok: true, status: 201 }; },
      assign: async () => { order.push('assign'); return { ok: true, status: 204 }; },
      enqueue: () => { order.push('enqueue'); },
    });
    const result = await performClaim('BBZ-9', 'taking this one', d);
    expect(result).toEqual({ ok: true, stage: 'claimed' });
    expect(order).toEqual(['comment', 'assign', 'enqueue']);
    expect(d.rows.at(-1)).toMatchObject({ event: 'claim.taken', ticket: 'BBZ-9' });
  });

  it('never assigns or queues when the comment was refused', async () => {
    // A ticket reassigned with no comment is the change nobody can explain on standup.
    const assign = vi.fn();
    const enqueue = vi.fn();
    const d = deps({ comment: async () => ({ ok: false, status: 400, body: 'Comment body is not valid!' }), assign, enqueue });
    const result = await performClaim('BBZ-9', 'bad body', d);
    expect(result).toMatchObject({ ok: false, stage: 'comment' });
    expect(assign).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('leaves the comment standing and does not queue when the assign was refused', async () => {
    const enqueue = vi.fn();
    const d = deps({ assign: async () => ({ ok: false, status: 403, body: 'no permission' }), enqueue });
    const result = await performClaim('BBZ-9', 'taking this', d);
    expect(result).toMatchObject({ ok: false, stage: 'assign' });
    if (!result.ok) expect(result.reason).toMatch(/commented, but the assign was refused/);
    // The queue must never own a ticket the board does not show as ours.
    expect(enqueue).not.toHaveBeenCalled();
    expect(d.rows.at(-1)).toMatchObject({ event: 'claim.refused', stage: 'assign' });
  });

  it('reports the stage when the queue itself throws', async () => {
    const d = deps({ enqueue: () => { throw new Error('queue lock held elsewhere'); } });
    const result = await performClaim('BBZ-9', 'taking this', d);
    expect(result).toMatchObject({ ok: false, stage: 'enqueue' });
    if (!result.ok) expect(result.reason).toMatch(/queue lock held elsewhere/);
  });
});

describe('claimBlocked', () => {
  it('allows a claim when nothing has been claimed', () => {
    expect(claimBlocked([], 0, 10_000)).toBeNull();
  });

  it('stops at the per-pass cap', () => {
    expect(claimBlocked([], CLAIMS_PER_PASS, 10_000)).toMatch(/this pass/);
  });

  it('stops at the hourly cap and forgets claims older than an hour', () => {
    const now = 10 * 60 * 60 * 1000;
    const recent = Array.from({ length: CLAIMS_PER_HOUR }, (_, i) => ({ ticket: `BBZ-${i}`, at: now - 60_000 }));
    expect(claimBlocked(recent, 0, now)).toMatch(/in the last hour/);
    const old = recent.map((row) => ({ ...row, at: now - 2 * 60 * 60 * 1000 }));
    expect(claimBlocked(old, 0, now)).toBeNull();
  });
});

describe('parseClaim', () => {
  it('reads a claim with a real repo', () => {
    const parsed = parseClaim(
      ['ACTION: claim', 'REPO: BOLTBETZ-LLC/v2-React-Native', 'WHY: the fix is one screen', 'REPLY: taking this, will have a PR today'].join('\n'),
      REPOS,
    );
    expect(parsed).toEqual({
      action: 'claim', repo: 'BOLTBETZ-LLC/v2-React-Native',
      why: 'the fix is one screen', reply: 'taking this, will have a PR today',
    });
  });

  it('downgrades a claim naming a repo we cannot route to', () => {
    // The queue would have nowhere to put it, and the drafted reply is still worth having.
    const parsed = parseClaim('ACTION: claim\nREPO: some/other-repo\nWHY: looks easy\nREPLY: on it', REPOS);
    expect(parsed?.action).toBe('defer');
    expect(parsed?.reply).toBe('on it');
    expect(parsed?.why).toMatch(/not a repository work can land in/);
  });

  it('keeps a multi-line reply whole', () => {
    const parsed = parseClaim('ACTION: answer\nREPO: none\nWHY: question\nREPLY: line one\nline two', REPOS);
    expect(parsed?.reply).toBe('line one\nline two');
  });

  it('reads the same fields out of JSON', () => {
    const parsed = parseClaim('{"action":"defer","repo":"none","why":"needs a priority call","reply":"I will ask"}', REPOS);
    expect(parsed?.action).toBe('defer');
    expect(parsed?.why).toBe('needs a priority call');
  });

  it('returns null when there is no readable action', () => {
    expect(parseClaim('sure, I can do that', REPOS)).toBeNull();
  });
});

describe('claimPrompt', () => {
  const prompt = claimPrompt({
    ticket: 'BBZ-9', summary: 'Deposit shows a stale balance', description: 'Only after a card deposit.',
    status: 'To Do', comment: { author: 'Haiping Chen', body: 'can you take this one?' }, repos: REPOS,
  }, 'Aaron Lilla');

  it('carries the ticket, the comment and the routable repos', () => {
    expect(prompt).toContain('BBZ-9: Deposit shows a stale balance');
    expect(prompt).toContain('Haiping Chen commented');
    expect(prompt).toContain('BOLTBETZ-LLC/v2-React-Native');
  });

  it('writes in the operator voice rather than describing an agent', () => {
    expect(prompt).toMatch(/^You are Aaron Lilla/);
    expect(prompt).not.toMatch(/\bagent\b|\bassistant\b|\bAI\b/i);
  });

  it('tells the model to defer rather than claim something vague', () => {
    expect(prompt).toMatch(/Claim only what you would genuinely start today/);
    expect(prompt).toMatch(/waiting on\s+somebody else, and a ticket whose repository is not listed above are all defer/);
  });
});
