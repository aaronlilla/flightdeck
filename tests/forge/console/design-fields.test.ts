/**
 * The fields the design's screens read that the routes did not carry before:
 * a blocker's "who can do it", a queued item's "why it is next" and "when it starts",
 * the flight review's other tiles, and the rail's blocker card off `blocker.raised`.
 */
import { describe, expect, it } from 'vitest';

import { detectBlockers, type DetectionInputs } from '../../../src/forge/console/blockers.js';
import { queueOrderWords } from '../../../src/forge/console/queue-route.js';
import { computeMetrics, slowestHop } from '../../../src/forge/console/proposals.js';
import { blockerCardFor, computeThread } from '../../../src/forge/console/thread.js';
import type { ForgeEvent } from '../../../src/forge/journal.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

function event(partial: Partial<ForgeEvent> & { event: string; at: number }): ForgeEvent {
  return { id: `e-${partial.at}-${partial.event}`, seq: 1, version: 1, actor: 'test', ...partial };
}

const now = Date.parse('2026-09-09T12:00:00');

const inputs = (): DetectionInputs => ({
  now,
  asks: [{ key: 'ask-1', question: 'NOT NULL or nullable?', runs: ['run-a'], at: now - 60_000 }],
  integrations: [{ id: 'sentry', name: 'Sentry', status: 'down', cause: 'token expired', fix: null, fixLabel: null, since: now - 120_000, dependents: ['run-b'] }],
  lanes: [
    { id: 'run-a', title: 'Alpha', ticket: 'ABC-1', repo: 'o/r', state: 'parked', observedAt: now, pr: null, mergeable: null },
    { id: 'run-b', title: 'Beta', ticket: 'ABC-2', repo: 'o/r', state: 'blocked', observedAt: now, pr: null, mergeable: null },
    { id: 'run-c', title: 'Gamma', ticket: 'ABC-3', repo: 'o/r', state: 'done', observedAt: now, pr: { no: 7, checks: 'success' }, mergeable: { ok: false, why: 'controlled code: only Joe merges this repo' } },
  ],
  billing: [{ repo: 'o/r', pr: 9, runId: 'r1', headSha: 'abc', message: 'billing is off' }],
  registryLive: new Set(),
});

describe('a blocker names who can clear it', () => {
  it('reads You for a question or an integration, the vendor for billing, the owner for a merge', () => {
    const byKind = new Map(detectBlockers(inputs()).map((b) => [b.kind, b]));
    expect(byKind.get('question')?.who).toBe('You');
    expect(byKind.get('integration')?.who).toBe('You');
    expect(byKind.get('billing')?.who).toBe('GitHub billing');
    expect(byKind.get('owner')?.who).toBe('Joe');
    expect(byKind.get('owner')?.whoNote).toBe('owns the repo');
  });
});

function item(partial: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    source: 'ticket', input: partial.id, ticket: partial.id, repo: null, briefPath: null, branch: null, worktreePath: null,
    base: null, state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: now, updatedAt: now, ...partial,
  };
}

describe('a queued item says why it is next and when it starts', () => {
  it('the first item takes a free slot, the one behind it waits for the next slot', () => {
    const all = [item({ id: 'ABC-1' }), item({ id: 'ABC-2' }), item({ id: 'ABC-3', state: 'running' })];
    const first = queueOrderWords(all[0]!, all, { paused: false, maxInFlight: 2, inFlight: 1 });
    const second = queueOrderWords(all[1]!, all, { paused: false, maxInFlight: 2, inFlight: 1 });
    expect(first.whyNext).toMatch(/^First in the queue, from a ticket in Ready for Dev/);
    expect(first.startsIn).toBe('Takes a free slot on the next tick');
    expect(second.startsIn).toBe('When the next slot frees');
  });

  it('an after: line holds an item behind the slug it names, and a paused queue holds everything', () => {
    const all = [item({ id: 'ABC-1', after: ['flt-2'] })];
    const held = queueOrderWords(all[0]!, all, { paused: false, maxInFlight: 2, inFlight: 0 });
    expect(held.whyNext).toContain('wait for flt-2');
    expect(held.startsIn).toBe('After flt-2 finishes');
    expect(queueOrderWords(all[0]!, all, { paused: true, maxInFlight: 2, inFlight: 0 }).startsIn).toBe('When the queue resumes');
    // A done predecessor clears the hold the way the scheduler reads it: any case, by ticket or branch.
    const cleared = [item({ id: 'ABC-1', after: ['flt-2'] }), item({ id: 'FLT-2', state: 'done', branch: 'feature/FLT-2' })];
    expect(queueOrderWords(cleared[0]!, cleared, { paused: false, maxInFlight: 2, inFlight: 0 }).startsIn).toBe('Takes a free slot on the next tick');
    expect(queueOrderWords(item({ id: 'X', state: 'review' }), all, { paused: false, maxInFlight: 2, inFlight: 0 })).toEqual({});
  });
});

describe('the flight review counts the day', () => {
  it('tickets in, handed to QA, blockers cleared and the slowest step come off the journal', () => {
    const start = new Date(now); start.setHours(1, 0, 0, 0);
    const t = start.getTime();
    const events = [
      event({ event: 'queue.planned', at: t, item: 'q1' }),
      event({ event: 'queue.launched', at: t + 5 * 60_000, item: 'q1' }),
      event({ event: 'queue.review', at: t + 65 * 60_000, item: 'q1' }),
      event({ event: 'blocker.cleared', at: t + 70 * 60_000 }),
      event({ event: 'run.parked', at: t + 10 * 60_000, key: 'k1', run: 'r1' }),
      event({ event: 'ask.answered', at: t + 22 * 60_000, key: 'k1' }),
    ];
    const metrics = computeMetrics(events, now, {});
    expect(metrics.ticketsIn).toBe(1);
    expect(metrics.handedToQa).toBe(1);
    expect(metrics.blockersCleared).toBe(1);
    expect(metrics.slowestHop).toEqual({ name: 'Working a ticket to a draft PR', minutes: 60 });
    expect(slowestHop([], 0)).toBeNull();
  });
});

describe('a raised blocker is a card in the rail', () => {
  it('names the lane, what stopped, and the two things the operator can do', () => {
    const row = event({ event: 'blocker.raised', at: now, key: 'sentry', what: 'the Sentry token expired', runs: ['run-b'] });
    const card = blockerCardFor(row, (id) => (id === 'run-b' ? 'ABC-2' : null));
    expect(card.type).toBe('blocker');
    expect(card.kicker).toBe('Blocked · ABC-2');
    expect(card.title).toBe('ABC-2 cannot go on: the Sentry token expired');
    expect(card.btns?.map((b) => b.cmd)).toEqual(['open blockers', 'open lane run-b']);
    const thread = computeThread([{ k: 'op', type: 'operator', text: 'hi', ts: now - 1, source: 'operator' }], [row], now);
    expect(thread.messages.some((m) => m.type === 'blocker')).toBe(true);
  });
});
