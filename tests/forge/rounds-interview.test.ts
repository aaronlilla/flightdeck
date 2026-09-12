/**
 * Item 3 of the pipeline-hardening brief (2026-09-11): the rounds sweep relaunches an
 * item that is legitimately holding on an operator's question.
 *
 * The live specimen, 2026-09-11, on the player-card ticket:
 *   {"state":"parked","reason":"rounds: planning for 30 min with no run on the board"}
 * followed by an auto-relaunch back to `queued`, while the item was waiting on two
 * unanswered interview questions. An interview ask registers no Blocker, so the only
 * exemption the dead-worker branch carries never applied.
 */
import { describe, expect, it } from 'vitest';

import { planRounds } from '../../src/forge/rounds.js';
import type { QueueItem } from '../../src/shared/console-model.js';

const NOW = 10_000_000;
const MIN = 60_000;

function item(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    source: 'ticket', input: 'BBZ-289', ticket: 'BBZ-289', repo: 'o/r', briefPath: null,
    branch: null, worktreePath: null, base: 'main', state: 'planning', reason: null, runKey: null, pr: null,
    journalIds: [], createdAt: NOW - 60 * MIN, updatedAt: NOW - 45 * MIN,
    ...overrides,
  };
}

function deadWorkerFindings(row: QueueItem) {
  const sheet = planRounds({ now: NOW, items: [row], lanes: [], blockers: [] });
  return sheet.findings.filter((finding) => finding.kind === 'dead-worker' && finding.itemId === row.id);
}

describe('item 3: the rounds sweep leaves an item held on an interview answer alone', () => {
  it('raises no dead-worker finding for a lane-less item waiting on an interview for 45 minutes', () => {
    expect(deadWorkerFindings(item({ id: 'Q-interview', reason: 'interview' }))).toEqual([]);
  });

  it('still raises one for the same silent item with no reason at all', () => {
    const findings = deadWorkerFindings(item({ id: 'Q-silent', reason: null }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.action).toBe('relaunch');
  });

  it('says on the sheet what the interview item is waiting on, rather than hiding it', () => {
    const row = item({ id: 'Q-interview', reason: 'interview' });
    const sheet = planRounds({ now: NOW, items: [row], lanes: [], blockers: [] });
    const waiting = sheet.waiting.find((entry) => entry.itemId === 'Q-interview');
    expect(waiting).toBeTruthy();
    expect(waiting!.on).toMatch(/answer/i);
  });

  it('does not exempt an item whose reason is interview but which is already running a worker', () => {
    // `isWaitingOnInterview` is state-scoped on purpose: only a `planning` item is held on
    // an answer. A `running` row carrying a leftover reason is a dead worker like any other.
    const findings = deadWorkerFindings(item({ id: 'Q-running', state: 'running', reason: 'interview' }));
    expect(findings).toHaveLength(1);
  });

  it('does not exempt an item parked on a reason that merely mentions an interview', () => {
    const findings = deadWorkerFindings(item({ id: 'Q-near', reason: 'interviewer never answered' }));
    expect(findings).toHaveLength(1);
  });
});
