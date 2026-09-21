/**
 * The goal audit and the progress notes AS THE QUEUE CALLS THEM. `ticketProgress.test.ts`
 * proves the two stages in isolation; these specimens prove the wiring, which is where the
 * mistakes live: a stage that never fires, a park that comments on every tick, a comment
 * failure that loses the transition that earned it.
 *
 * Nothing here touches git, Jira or the network. The planner is canned, the audit and the
 * note writer are injected, and the store is a real one over a temp directory.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainGh, ChainLauncher, ChainRunStatus } from '../../../src/forge/chain.js';
import { addTicketItem, advanceItem, type QueueRuntimeDeps } from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { ProgressNote } from '../../../src/forge/intake/ticketProgress.js';

type Extra = Partial<Pick<QueueRuntimeDeps, 'goalAudit' | 'noteProgress'>>;

interface Harness {
  deps: QueueRuntimeDeps;
  events: Record<string, unknown>[];
  store: QueueStore;
}

function harness(extra: Extra): Harness {
  const store = new QueueStore(join(mkdtempSync(join(tmpdir(), 'queue-prog-')), 'queue.jsonl'));
  const events: Record<string, unknown>[] = [];
  let seq = 0;

  const deps: QueueRuntimeDeps = {
    planner: {
      planTicket: async (ticket: string) => ({ ticket, repo: 'owner/name', briefPath: `C:/briefs/${ticket}.md` }),
      planBrief: async () => ({ ticket: 'BRIEF-1', repo: 'owner/name', briefPath: 'C:/briefs/brief-1.md' }),
    },
    launcher: {
      provision: async ({ ticket }) => ({
        worktreePath: `C:/worktrees/repo--${ticket.toLowerCase()}`, branch: `feature/${ticket.toLowerCase()}`, base: 'develop',
      }),
      launch: async ({ ticket }) => ({ runKey: ticket.toLowerCase() }),
      status: async (): Promise<ChainRunStatus> => ({ finished: false }),
      runRegistered: async () => false,
    } as ChainLauncher,
    gh: { findPrByHead: async () => undefined } as ChainGh,
    council: async () => ({ verdict: 'PASS' }),
    gate: async () => ({ merged: false }),
    clock: () => 1_000,
    killSwitch: () => false,
    paused: () => false,
    maxInFlight: () => 4,
    append: (event) => {
      seq += 1;
      events.push({ id: `e${seq}`, ...event });
      return { id: `e${seq}` };
    },
    store,
    ...extra,
  };
  return { deps, events, store };
}

const eventNames = (events: Record<string, unknown>[]): unknown[] => events.map((e) => e['event']);

describe('the goal audit, at the plan hop', () => {
  it('launches nothing when the goal never passes its critic; it parks with the critic reason', async () => {
    const h = harness({
      goalAudit: async () => ({
        ok: false, reason: 'the goal did not pass its audit in 3 rounds; last gap: it never touches the ledger',
        bestGoal: 'x', rounds: 3,
      }),
    });
    const item = addTicketItem(h.store, 'BBZ-901');

    const next = await advanceItem(item, h.deps);

    expect(next.state).toBe('parked');
    expect(next.reason).toContain('never touches the ledger');
    const parked = h.events.find((e) => e['event'] === 'queue.parked');
    expect(parked?.['hop']).toBe('goal-audit');
    expect(eventNames(h.events)).not.toContain('queue.planned');
  });

  it('says the audit could not RUN, distinctly from the goal failing', async () => {
    const h = harness({ goalAudit: async () => { throw new Error('the critic model timed out'); } });
    const item = addTicketItem(h.store, 'BBZ-902');

    const next = await advanceItem(item, h.deps);

    expect(next.state).toBe('parked');
    expect(next.reason).toContain('could not run');
    expect(h.events.find((e) => e['event'] === 'queue.parked')?.['audit']).toBe('errored');
  });

  it('lets a passing goal through, and journals the pass', async () => {
    const h = harness({ goalAudit: async () => ({ ok: true, goal: 'a good goal', rounds: 2 }) });
    const item = addTicketItem(h.store, 'BBZ-903');

    const next = await advanceItem(item, h.deps);

    expect(next.state).toBe('running');
    expect(eventNames(h.events)).toContain('queue.goal-audited');
    expect(eventNames(h.events)).toContain('queue.planned');
  });

  it('behaves exactly as before when no audit is wired', async () => {
    const h = harness({});
    const item = addTicketItem(h.store, 'BBZ-904');

    const next = await advanceItem(item, h.deps);

    expect(next.state).toBe('running');
    expect(eventNames(h.events)).not.toContain('queue.goal-audited');
  });
});

describe('the ticket learning what happened to it', () => {
  it('comments on a park, naming the reason and the ticket', async () => {
    const notes: ProgressNote[] = [];
    const h = harness({
      noteProgress: (n) => notes.push(n),
      goalAudit: async () => ({ ok: false, reason: 'the goal did not pass', bestGoal: '', rounds: 3 }),
    });
    const item = addTicketItem(h.store, 'BBZ-905');

    await advanceItem(item, h.deps);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.stage).toBe('parked');
    expect(notes[0]!.reason).toContain('did not pass');
    expect(notes[0]!.ticket).toBe('BBZ-905');
  });

  it('says nothing for planning and running, which move constantly', async () => {
    const notes: ProgressNote[] = [];
    const h = harness({
      noteProgress: (n) => notes.push(n),
      goalAudit: async () => ({ ok: true, goal: 'g', rounds: 1 }),
    });
    const item = addTicketItem(h.store, 'BBZ-906');

    await advanceItem(item, h.deps);

    expect(notes).toHaveLength(0);
  });

  it('does not comment twice when a later hop rewrites an already-parked item', async () => {
    const notes: ProgressNote[] = [];
    const h = harness({
      noteProgress: (n) => notes.push(n),
      goalAudit: async () => ({ ok: false, reason: 'still no', bestGoal: '', rounds: 3 }),
    });
    const item = addTicketItem(h.store, 'BBZ-907');

    const parked = await advanceItem(item, h.deps);
    expect(notes).toHaveLength(1);

    await advanceItem(parked, h.deps);
    expect(notes).toHaveLength(1);
  });

  it('keeps the transition when the note writer throws', async () => {
    const h = harness({
      noteProgress: () => { throw new Error('jira is down'); },
      goalAudit: async () => ({ ok: false, reason: 'no', bestGoal: '', rounds: 1 }),
    });
    const item = addTicketItem(h.store, 'BBZ-908');

    const next = await advanceItem(item, h.deps);

    expect(next.state).toBe('parked');
    expect(h.store.get(item.id)!.state).toBe('parked');
  });

  it('writes nothing at all when no note writer is wired', async () => {
    const h = harness({ goalAudit: async () => ({ ok: false, reason: 'no', bestGoal: '', rounds: 1 }) });
    const item = addTicketItem(h.store, 'BBZ-909');

    const next = await advanceItem(item, h.deps);

    expect(next.state).toBe('parked');
  });
});
