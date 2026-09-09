import { describe, expect, it } from 'vitest';

import {
  boardCta, boardStateWord, blockerFor, durationWords, groupLanesByTicket, idleReason, kindLabel, laneHeadline,
  tileHeadlineParts, timeInStateText,
} from '../../src/console/laneVM.js';
import type { Blocker, Lane, LaneState, QueueItem } from '../../src/shared/console-model.js';

function lane(state: LaneState, extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: null, className: null, repo: null, attempt: 1, state,
    reason: null, stepN: 1, stepTotal: 6, stepText: 'working', ctxTokens: 0, ctxCeiling: 1, ctxCompactAt: 1, tokens: 0, tokenCap: null,
    tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: null, heart: false, since: 0, startedAt: 0,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, didVerbatim: false, now: '', you: null, ...extra,
  };
}

const blocker = (extra: Partial<Blocker>): Blocker => ({
  id: 'b', kind: 'integration', title: 't', detail: 'd', youCanResolve: true, howToResolve: 'h', links: [], blocks: [{ laneId: 'FLT-1', label: 'FLT-1' }],
  blockedBy: [], state: 'open', since: 0, checkedAt: null, resolvedAt: null, thenWhat: 'w', lastCheck: null, ...extra,
});

describe('boardStateWord', () => {
  it('maps every lane state onto one of the design\'s five words with its border and ground', () => {
    expect(boardStateWord(lane('running')).word).toBe('Working');
    expect(boardStateWord(lane('parked', { question: { key: 'k', text: 'q', opts: [], askedAt: 0 } }))).toMatchObject({ word: 'Needs you', background: 'var(--warnTint)' });
    expect(boardStateWord(lane('done', { pr: { no: 1, url: 'u', draft: false, merged: false }, mergeable: { ok: true } })).word).toBe('Ready to merge');
    expect(boardStateWord(lane('blocked'))).toMatchObject({ word: 'Blocked', border: 'var(--line2)' });
    expect(boardStateWord(lane('running', { runaway: true })).word).toBe('Needs you');
  });
});

describe('boardCta', () => {
  it('gives each state the one button the design names', () => {
    expect(boardCta(lane('running')).label).toBe('Watch');
    expect(boardCta(lane('parked', { question: { key: 'k', text: 'q', opts: [], askedAt: 0 } }))).toMatchObject({ label: 'Answer', kind: 'warn' });
    expect(boardCta(lane('parked')).label).toBe('Resume');
    expect(boardCta(lane('done', { pr: { no: 1, url: 'u', draft: false, merged: false }, mergeable: { ok: true } }))).toMatchObject({ label: 'Merge', kind: 'primary' });
    expect(boardCta(lane('done', { mergeable: { ok: false, why: 'checks red' } })).label).toBe('Re-check');
    expect(boardCta(lane('running', { runaway: true })).label).toBe('Kill attempt');
    expect(boardCta(lane('exhausted')).cmd).toBe('compact');
    expect(boardCta(lane('killed')).cmd).toBe('reopen');
    expect(boardCta(lane('running', { retiredAt: 1 })).cmd).toBe('unretire');
  });

  it('a blocker decides the button on a blocked lane', () => {
    expect(boardCta(lane('blocked'), blocker({ kind: 'integration' })).label).toBe('Fix in Settings');
    expect(boardCta(lane('blocked'), blocker({ kind: 'owner', who: 'Dana' })).label).toBe('Nudge Dana');
    expect(boardCta(lane('blocked'), blocker({ kind: 'billing', links: [{ label: 'billing', url: 'https://b' }] })).cmd).toBe('open-url:https://b');
    expect(blockerFor(lane('blocked'), [blocker({ state: 'resolved' })])).toBeNull();
    expect(blockerFor(lane('blocked'), [blocker({})])?.id).toBe('b');
  });
});

describe('time in state', () => {
  it('reads the design\'s duration form and the verb of the state word', () => {
    expect(durationWords(30_000)).toBe('under a minute');
    expect(durationWords(14 * 60_000)).toBe('14 min');
    expect(durationWords(72 * 60_000)).toBe('1 h 12 min');
    expect(durationWords(3 * 3_600_000)).toBe('3 h');
    expect(timeInStateText(lane('running', { since: 0 }), 9 * 60_000, 'Working')).toBe('9 min working');
    expect(timeInStateText(lane('parked', { since: 0 }), 60_000, 'Blocked')).toBe('1 min parked');
  });
});

describe('idleReason', () => {
  const item = (extra: Partial<QueueItem>): QueueItem => ({
    id: 'q', source: 'ticket', input: 'A-1', ticket: 'A-1', repo: null, briefPath: null, branch: null, worktreePath: null, base: null,
    state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: 0, updatedAt: 0, ...extra,
  });
  it('names the queue\'s own reason for an idle slot', () => {
    expect(idleReason({ items: [], paused: false, pauseReason: null, on: false })).toContain('the queue is off');
    expect(idleReason({ items: [], paused: true, pauseReason: 'backoff', on: true })).toContain('paused (backoff)');
    expect(idleReason({ items: [], paused: false, pauseReason: null, on: true })).toContain('nothing is in the queue');
    expect(idleReason({ items: [item({ after: ['b-2'] })], paused: false, pauseReason: null, on: true })).toContain('A-1 waits for b-2');
    expect(idleReason({ items: [item({ after: ['b-2'] }), item({ id: 'd', ticket: 'B-2', input: 'B-2', state: 'done' })], paused: false, pauseReason: null, on: true })).toContain('1 queued');
  });
});

describe('headlines', () => {
  it('a ticket outranks a title, a title outranks the fallback, and the run id is never the text', () => {
    expect(laneHeadline(lane('running', { ticket: 'FLT-9', title: 'T' })).main).toBe('FLT-9');
    expect(laneHeadline(lane('running', { ticket: null, title: 'T' })).main).toBe('T');
    expect(laneHeadline(lane('running', { ticket: null, title: null, id: 'abcdef0123456789' }))).toEqual({ main: 'Untitled run', runId: 'abcdef0123456789' });
    expect(tileHeadlineParts(lane('running', { ticket: null, title: 'T' }))).toEqual({ key: null, title: 'T', runId: 'FLT-1' });
    expect(kindLabel('hotfix')).toBe('hotfix');
  });

  it('lanes sharing a ticket fold into one group, newest attempt first', () => {
    const groups = groupLanesByTicket([lane('running', { id: 'a', attempt: 1 }), lane('killed', { id: 'b', attempt: 2 }), lane('running', { id: 'c', ticket: 'FLT-2' })]);
    expect(groups.map((g) => g.key)).toEqual(['FLT-1', 'FLT-2']);
    expect(groups[0]!.lanes.map((l) => l.id)).toEqual(['b', 'a']);
  });
});
