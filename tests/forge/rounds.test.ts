/**
 * `planRounds` against a board seeded with one of each thing the rounds are for: a row
 * whose PR merged, a running row whose worker died, a parked row whose blocker cleared,
 * a parked row nobody is holding, a worker asking "may I stop", a finished lane with no
 * queue row, and one healthy running row that must be left alone. `applyRounds` then
 * runs the mechanical actions through the queue's own store.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QueueStore } from '../../src/forge/intake/queueStore.js';
import { applyRounds, formatRoundsSheet, planRounds, relaunchItem } from '../../src/forge/rounds.js';
import type { Blocker, Lane, QueueItem } from '../../src/shared/console-model.js';

const NOW = 10_000_000;
const MIN = 60_000;

function item(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    source: 'brief', input: '# Goal: something\n\nbody', ticket: null, repo: 'o/r', briefPath: null,
    branch: null, worktreePath: null, base: 'main', state: 'queued', reason: null, runKey: null, pr: null,
    journalIds: [], createdAt: NOW - 60 * MIN, updatedAt: NOW - 60 * MIN,
    ...overrides,
  };
}

function lane(overrides: Partial<Lane> & { id: string }): Lane {
  return {
    ticket: null, model: 'sonnet-5', modelId: null, className: null, repo: null, attempt: 1,
    state: 'running', reason: null, stepN: 0, stepTotal: 0, stepText: '', ctxTokens: 0, ctxCeiling: 0,
    ctxCompactAt: 0, tokens: 0, tokenCap: null, tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live',
    observedAt: NOW - MIN, verifiedAt: null, heart: false, since: NOW - 60 * MIN, startedAt: NOW - 60 * MIN,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    title: null, kind: 'manual', sourceUrl: null, plain: '', now: '', did: null, you: null, mergeable: null,
    attempts: 1, retiredAt: null, live: { alive: true, pid: 1, lastEventAt: NOW - MIN, checkedAt: NOW },
    ...overrides,
  } as Lane;
}

function blocker(overrides: Partial<Blocker> & { id: string; kind: Blocker['kind'] }): Blocker {
  return {
    title: 't', detail: 'd', youCanResolve: true, howToResolve: 'h', links: [], blocks: [], blockedBy: [],
    state: 'open', since: NOW - 30 * MIN, checkedAt: null, resolvedAt: null, thenWhat: '', lastCheck: null,
    ...overrides,
  };
}

const board = {
  items: [
    item({ id: 'Q-merged', ticket: 'BBZ-1', state: 'review', runKey: 'run-merged', pr: { no: 12, url: 'u', draft: false, merged: true } }),
    item({ id: 'Q-dead', ticket: 'BBZ-2', state: 'running', runKey: 'run-dead', updatedAt: NOW - 90 * MIN }),
    item({ id: 'Q-killed', ticket: 'BBZ-3', state: 'running', runKey: 'run-killed' }),
    item({ id: 'Q-cleared', ticket: 'BBZ-4', state: 'parked', runKey: 'run-cleared', reason: 'refused: checks are failure' }),
    item({ id: 'Q-nobody', ticket: 'BBZ-5', state: 'parked', runKey: 'run-nobody', reason: 'parked', updatedAt: NOW - 200 * MIN }),
    item({ id: 'Q-transient', ticket: 'BBZ-6', state: 'parked', reason: 'conflicts with main: error: cannot rebase: You have unstaged changes.' }),
    item({ id: 'Q-ask', ticket: 'BBZ-7', state: 'parked', runKey: 'run-ask' }),
    item({ id: 'Q-waiting', ticket: 'BBZ-8', state: 'parked', runKey: 'run-waiting' }),
    item({ id: 'Q-healthy', ticket: 'BBZ-9', state: 'running', runKey: 'run-healthy' }),
    item({ id: 'Q-quiet', ticket: 'BBZ-10', state: 'running', runKey: 'run-quiet' }),
    item({ id: 'Q-done', ticket: 'BBZ-11', state: 'done', runKey: 'run-done' }),
    item({ id: 'Q-blocked-dead', ticket: 'BBZ-12', state: 'running', runKey: 'run-blocked-dead' }),
    item({ id: 'Q-paused-dead', ticket: 'BBZ-13', state: 'running', runKey: 'run-paused-dead' }),
    item({ id: 'Q-capped', ticket: 'BBZ-14', state: 'running', runKey: 'run-capped' }),
    item({ id: 'Q-integration', ticket: 'BBZ-15', state: 'running', runKey: 'run-integration' }),
  ],
  lanes: [
    lane({ id: 'run-merged', state: 'merged', pr: { no: 12, url: 'u', draft: false, merged: true } }),
    lane({ id: 'run-killed', state: 'killed', reason: 'killed by operator' }),
    lane({ id: 'run-cleared', state: 'parked' }),
    lane({ id: 'run-nobody', state: 'parked' }),
    lane({ id: 'run-ask', state: 'parked', question: { key: 'k1', text: 'BBZ-7 is already merged as PR #100 and has zero diff to ship. Should I open a PR anyway?', opts: [], askedAt: NOW - 40 * MIN } }),
    lane({ id: 'run-waiting', state: 'blocked' }),
    lane({ id: 'run-healthy' }),
    lane({ id: 'run-quiet', live: { alive: false, pid: null, lastEventAt: NOW - 10 * MIN, checkedAt: NOW }, observedAt: NOW - 10 * MIN }),
    lane({ id: 'run-done', state: 'done', endedAt: NOW - 2 * 60 * MIN }),
    lane({ id: 'orphan-old', state: 'killed', endedAt: NOW - 30 * 60 * MIN, observedAt: NOW - 30 * 60 * MIN, live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'orphan-fresh', state: 'killed', endedAt: NOW - 2 * 60 * MIN, live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'orphan-retired', state: 'killed', endedAt: NOW - 30 * 60 * MIN, retiredAt: NOW - 60 * MIN }),
    lane({ id: 'orphan-open-pr', state: 'done', endedAt: NOW - 30 * 60 * MIN, pr: { no: 5, url: 'u', draft: true, merged: false } }),
    // Follow-up to R-61: a PR closed without merging is a dead end, same as merged --
    // the automatic sweep must catch it, not just an operator's manual retire.
    lane({ id: 'orphan-closed-pr', state: 'done', endedAt: NOW - 30 * 60 * MIN, pr: { no: 6, url: 'u', draft: true, merged: false, closed: true } }),
    lane({ id: 'zombie', state: 'running', observedAt: NOW - 3 * 60 * MIN, live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'zombie-parked', state: 'parked', observedAt: NOW - 3 * 60 * MIN, live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'run-blocked-dead', state: 'blocked', reason: 'its process is gone and it never reported finishing', live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'run-paused-dead', state: 'paused', live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'run-capped', state: 'blocked', reason: 'this run was relaunched once already and died again; parking', live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'run-integration', state: 'blocked', blockedBy: 'github', reason: 'GitHub is not connecting', live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
    lane({ id: 'run-gone-ask', state: 'killed', retiredAt: NOW - MIN, endedAt: NOW - 50 * MIN, live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW } }),
  ],
  blockers: [
    blocker({ id: 'checks:o/r#7', kind: 'checks', title: 'Checks failing on PR #7', state: 'resolved', resolvedAt: NOW - MIN, blocks: [{ laneId: 'run-cleared', label: 'BBZ-4' }] }),
    blocker({ id: 'integration:github', kind: 'integration', title: 'GitHub is not connecting', state: 'open', blocks: [{ laneId: 'run-waiting', label: 'BBZ-8' }] }),
    blocker({ id: 'question:k9', kind: 'question', title: 'BBZ-99 is fully implemented and verified; nothing left to ship. Close it?', state: 'open', blocks: [{ laneId: 'run-gone-ask', label: 'a run' }] }),
  ],
};
const priorRelaunches = (id: string) => (id === 'Q-capped' ? 2 : 0);

describe('planRounds', () => {
  const sheet = planRounds({ now: NOW, ...board, priorRelaunches });
  const byItem = (id: string) => sheet.findings.find((f) => f.itemId === id);
  const byLane = (id: string) => sheet.findings.find((f) => f.laneId === id && f.itemId === null);

  it('clears a row whose PR merged', () => {
    expect(byItem('Q-merged')).toMatchObject({ kind: 'done-still-open', action: 'remove' });
    expect(byItem('Q-merged')!.why).toContain('#12');
  });

  it('relaunches a running row with no run on the board past the silent cap', () => {
    expect(byItem('Q-dead')).toMatchObject({ kind: 'dead-worker', action: 'relaunch' });
  });

  it('relaunches a running row whose run was killed', () => {
    expect(byItem('Q-killed')).toMatchObject({ kind: 'dead-worker', action: 'relaunch' });
    expect(byItem('Q-killed')!.why).toContain('killed');
  });

  it('restarts a parked row whose blocker resolved, naming the blocker', () => {
    expect(byItem('Q-cleared')).toMatchObject({ kind: 'unblocked', action: 'retry' });
    expect(byItem('Q-cleared')!.why).toContain('Checks failing on PR #7');
  });

  it('restarts a parked row nothing on the board is holding', () => {
    expect(byItem('Q-nobody')).toMatchObject({ kind: 'unblocked', action: 'retry' });
    expect(byItem('Q-nobody')!.why).toContain('no blocker');
  });

  it('restarts a row parked by a launch collision with itself', () => {
    expect(byItem('Q-transient')!.why).toContain('dirty tree');
  });

  it('hands a question that reads as done to the judge with a suggested answer', () => {
    const f = byItem('Q-ask')!;
    expect(f).toMatchObject({ kind: 'ask', action: 'judge' });
    expect(f.ask).toMatchObject({ key: 'k1', looksDone: true });
    expect(f.ask!.suggested).toContain('draft PR');
  });

  it('leaves a row behind an open non-question blocker alone, and says so', () => {
    expect(byItem('Q-waiting')).toBeUndefined();
    expect(sheet.waiting).toContainEqual({ itemId: 'Q-waiting', label: 'BBZ-8', on: 'GitHub is not connecting' });
  });

  it('leaves a live worker and a briefly quiet one alone, and a done row entirely', () => {
    expect(byItem('Q-healthy')).toBeUndefined();
    expect(byItem('Q-quiet')).toBeUndefined();
    expect(byItem('Q-done')).toBeUndefined();
    expect(sheet.healthy.map((h) => h.itemId)).toEqual(['Q-healthy', 'Q-quiet']);
  });

  it('archives only the old, PR-less or merged, unretired orphan lane', () => {
    expect(byLane('orphan-old')).toMatchObject({ kind: 'orphan-lane', action: 'retire' });
    expect(byLane('orphan-fresh')).toBeUndefined();
    expect(byLane('orphan-retired')).toBeUndefined();
    expect(byLane('orphan-open-pr')).toBeUndefined();
    expect(byLane('run-done')).toBeUndefined();
  });

  it('also archives an orphan lane whose PR closed without merging -- dead, same as merged', () => {
    expect(byLane('orphan-closed-pr')).toMatchObject({ kind: 'orphan-lane', action: 'retire' });
  });

  it('names a lane that reads running with no process as a judge call, never a kill', () => {
    expect(byLane('zombie')).toMatchObject({ kind: 'zombie-lane', action: 'judge' });
    expect(byLane('zombie-parked')).toMatchObject({ kind: 'zombie-lane', action: 'judge' });
  });

  it('relaunches a running row the warden parked or paused for a dead process, with no silent cap', () => {
    expect(byItem('Q-blocked-dead')).toMatchObject({ kind: 'dead-worker', action: 'relaunch' });
    expect(byItem('Q-blocked-dead')!.why).toContain('its process is gone');
    expect(byItem('Q-paused-dead')).toMatchObject({ kind: 'dead-worker', action: 'relaunch' });
  });

  it('stops relaunching at the cap and hands the death to the judge', () => {
    expect(byItem('Q-capped')).toMatchObject({ kind: 'dead-worker', action: 'judge' });
    expect(byItem('Q-capped')!.why).toContain('2 times');
  });

  it('leaves a running row whose run is blocked on an integration to the blocker board', () => {
    expect(byItem('Q-integration')).toBeUndefined();
    expect(sheet.waiting.find((w) => w.itemId === 'Q-integration')!.on).toContain('github');
  });

  it('surfaces an open question whose lane is gone, with the done answer suggested', () => {
    const f = sheet.findings.find((x) => x.ask?.key === 'k9')!;
    expect(f).toMatchObject({ kind: 'ask', action: 'judge', itemId: null, label: 'BBZ-99' });
    expect(f.why).toContain('gone from the board');
    expect(f.ask!.looksDone).toBe(true);
  });

  it('prints a sheet a person can read, findings first and healthy rows by name', () => {
    const lines = formatRoundsSheet(sheet);
    expect(lines[0]).toMatch(/^Rounds \(dry run, nothing changed\): \d+ findings?, 2 waiting/);
    expect(lines.join('\n')).toContain('suggested answer:');
    expect(lines.join('\n')).toContain('BBZ-9 [Q-healthy] running: process alive');
  });
});

describe('applyRounds', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rounds-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('runs the mechanical actions through the store and journals each one; judge calls are only reported', () => {
    const store = new QueueStore(join(dir, 'queue.jsonl'));
    for (const row of board.items) store.append({ ...row, at: row.updatedAt });
    const sheet = planRounds({ now: NOW, ...board, priorRelaunches });
    const journal: Array<Record<string, unknown>> = [];
    const retired: string[] = [];
    const receipts = applyRounds(sheet, {
      store, journal: (e) => journal.push(e), now: () => NOW,
      retire: (id) => { retired.push(id); return { ok: true, message: `retired ${id}` }; },
    });

    expect(store.get('Q-merged')).toBeUndefined();
    expect(store.get('Q-dead')).toMatchObject({ state: 'running', retriedAt: NOW });
    expect(store.get('Q-killed')).toMatchObject({ state: 'running', retriedAt: NOW });
    expect(store.get('Q-cleared')).toMatchObject({ state: 'running', reason: null });
    expect(store.get('Q-transient')).toMatchObject({ state: 'queued', reason: null });
    expect(store.get('Q-ask')).toMatchObject({ state: 'parked' });
    expect(retired).toEqual(['orphan-old', 'orphan-closed-pr']);

    const applied = receipts.filter((r) => r.applied).map((r) => r.finding.itemId ?? r.finding.laneId);
    expect(applied).toEqual(['Q-merged', 'Q-dead', 'Q-killed', 'Q-cleared', 'Q-nobody', 'Q-transient', 'Q-blocked-dead', 'Q-paused-dead', 'orphan-old', 'orphan-closed-pr']);
    expect(journal.map((e) => e['event'])).toEqual(Array(10).fill('rounds.applied'));
    expect(store.get('Q-capped')!.state).toBe('running');
    expect(store.get('Q-capped')!.retriedAt).toBeUndefined();
    expect(receipts.find((r) => r.finding.kind === 'ask')).toMatchObject({ applied: false });
    expect(receipts.find((r) => r.finding.kind === 'ask')!.text).toContain('needs a reading');
  });

  it('relaunchItem parks then retries, so advanceItem sees a retry of an in-flight run', () => {
    const store = new QueueStore(join(dir, 'queue.jsonl'));
    store.append({ ...item({ id: 'Q-x', state: 'running', runKey: 'r' }), at: NOW });
    expect(relaunchItem(store, 'Q-x', 'rounds: dead', NOW)).toMatchObject({ state: 'running', retriedAt: NOW, reason: null });
    expect(relaunchItem(store, 'Q-missing', 'rounds: dead', NOW)).toBeUndefined();
  });
});
