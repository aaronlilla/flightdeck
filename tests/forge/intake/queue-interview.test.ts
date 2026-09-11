/**
 * The planning hop as an interview (R-76): one item's open question holds that item and
 * nothing else, the scout answers what the checkout can answer, and the brief is written
 * only once every ask is answered.
 *
 * Nothing here touches git, the network or a real reasoner: `execRun` and `Reasoner` are
 * both injected, and the inbox is a real one over a temp directory.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainGh, ChainLauncher, ChainRunStatus } from '../../../src/forge/chain.js';
import type { Packet, Reasoner } from '../../../src/forge/contracts.js';
import { Inbox } from '../../../src/forge/inbox.js';
import type { RunRequest, RunResult } from '../../../src/forge/exec.js';
import {
  addTicketItem, runQueueTick, type QueueRuntimeDeps,
} from '../../../src/forge/intake/queue.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { asksForItem, planTicketWithInterview } from '../../../src/forge/intake/interviewPlanner.js';
import { scoutAnswer } from '../../../src/forge/intake/scout.js';
import { MemoryInterviewStore } from '../../../src/forge/intake/interviewStore.js';

function tempStore(): QueueStore {
  return new QueueStore(join(mkdtempSync(join(tmpdir(), 'queue-iv-')), 'queue.jsonl'));
}

function tempInbox(): Inbox {
  return new Inbox(mkdtempSync(join(tmpdir(), 'inbox-iv-')));
}

function packetFor(ticket: string): Packet {
  return {
    id: `jira:${ticket}:1`, ticket, what: 'voucher list crashes when empty',
    where: 'jira', evidence: [`jira:${ticket}:1`], confidence: 'low', repo: 'unknown',
    blockedBy: [], at: 1,
  };
}

/** A reasoner that answers each call from a queue of canned JSON payloads, recording
 *  every prompt and class it was asked with. */
function scriptedReasoner(payloads: unknown[]): Reasoner & { prompts: string[]; classes: string[] } {
  const prompts: string[] = [];
  const classes: string[] = [];
  let index = 0;
  return {
    provider: 'claude',
    prompts,
    classes,
    async call(input) {
      prompts.push(input.prompt);
      classes.push(input.className);
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      return { text: typeof payload === 'string' ? payload : JSON.stringify(payload) };
    },
  };
}

function fakeExecRun(output: string, seen: RunRequest[]): (request: RunRequest) => Promise<RunResult> {
  return async (request) => {
    seen.push(request);
    return {
      owner: request.owner, argv: request.argv, returncode: 0, tail: output, full: output,
      startedAt: 0, durationMs: 1, ok: true,
    };
  };
}

interface Harness {
  deps: QueueRuntimeDeps;
  events: Record<string, unknown>[];
  inbox: Inbox;
  store: QueueStore;
  execSeen: RunRequest[];
  briefsWritten: string[];
}

function harness(reasoner: Reasoner, grepOutput = 'src/VoucherList.tsx:42:  const rows = data.vouchers;\n'): Harness {
  const store = tempStore();
  const inbox = tempInbox();
  const events: Record<string, unknown>[] = [];
  const execSeen: RunRequest[] = [];
  const briefsWritten: string[] = [];
  const records = new MemoryInterviewStore();
  let seq = 0;

  const planner = {
    planTicket: (ticket: string, itemId: string) => planTicketWithInterview(ticket, itemId, {
      reasoner,
      inbox,
      packetFor: async (key: string) => packetFor(key),
      scout: (question) => scoutAnswer(question, {
        cwd: 'C:/checkout', owner: 'test', reasoner,
        execRun: fakeExecRun(grepOutput, execSeen),
        readFile: () => 'const rows = data.vouchers;\n',
      }),
      writeBriefFile: async ({ ticket, text }) => {
        briefsWritten.push(text);
        return { briefPath: `C:/briefs/${ticket}.md`, repo: 'owner/name' };
      },
      records,
      append: (row) => { events.push({ id: `x${events.length}`, ...row }); },
    }),
    planBrief: async () => ({ ticket: 'BRIEF-1', repo: 'owner/name', briefPath: 'C:/briefs/brief-1.md' }),
  };

  const deps: QueueRuntimeDeps = {
    planner,
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
      const id = `e${seq}`;
      events.push({ id, ...event });
      return { id };
    },
    store,
  };
  return { deps, events, inbox, store, execSeen, briefsWritten };
}

const ONE_REPO_ONE_AARON = {
  route: 'frontend',
  questions: [
    { text: 'Which field does the voucher list read?', options: [], recommended: null, answerableBy: 'repo' },
    { text: 'Do we hide the row or show a zero?', options: ['hide', 'zero'], recommended: 0, answerableBy: 'aaron' },
  ],
};

const SCOUT_CANNOT_ANSWER = { answered: false, answer: '' };
const SCOUT_ANSWERS = { answered: true, answer: 'it reads data.vouchers', citation: 'src/VoucherList.tsx:42' };

describe('the planning hop as an interview', () => {
  it('holds one item at planning on an open question, with a queue.waiting row and exactly one ask', async () => {
    const reasoner = scriptedReasoner([ONE_REPO_ONE_AARON, SCOUT_ANSWERS]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-277');

    await runQueueTick(h.deps, [item]);

    const after = h.store.get(item.id)!;
    expect(after.state).toBe('planning');
    expect(after.reason).toBe('interview');

    const waiting = h.events.filter((row) => row['event'] === 'queue.waiting');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!['hop']).toBe('plan');
    expect(h.events.some((row) => row['event'] === 'queue.planned')).toBe(false);

    const asks = asksForItem(h.inbox, item.id);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toContain('hide the row');
    expect(asks[0]!.ticket).toBe('BBZ-277');
  });

  it('sends the repo question to the scout as a git grep for the question own terms', async () => {
    const reasoner = scriptedReasoner([ONE_REPO_ONE_AARON, SCOUT_ANSWERS]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-277');

    await runQueueTick(h.deps, [item]);

    expect(h.execSeen).toHaveLength(1);
    const argv = h.execSeen[0]!.argv;
    expect(argv.slice(0, 3)).toEqual(['git', 'grep', '-n']);
    expect(argv).toContain('voucher');
    expect(h.execSeen[0]!.cwd).toBe('C:/checkout');
    // The scout answered, so it never became an ask: only the operator's question did.
    expect(asksForItem(h.inbox, item.id)).toHaveLength(1);
  });

  it('a second item on the same tick advances normally while the first waits', async () => {
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) {
        if (input.prompt.includes('BBZ-277')) {
          if (input.className === 'research') return { text: JSON.stringify(SCOUT_ANSWERS) };
          return { text: JSON.stringify(ONE_REPO_ONE_AARON) };
        }
        if (input.prompt.includes('already interviewed')) return { text: '# Goal: fix BBZ-500\n' };
        return { text: JSON.stringify({ route: 'frontend', questions: [] }) };
      },
    };
    const h = harness(reasoner);
    const held = addTicketItem(h.store, 'BBZ-277');
    const moving = addTicketItem(h.store, 'BBZ-500');

    await runQueueTick(h.deps, [held, moving]);

    expect(h.store.get(held.id)!.state).toBe('planning');
    const second = h.store.get(moving.id)!;
    expect(second.state).toBe('running');
    expect(second.briefPath).toBe('C:/briefs/BBZ-500.md');
    expect(h.events.filter((row) => row['event'] === 'queue.planned')).toHaveLength(1);
  });

  it('answering the ask makes the next tick write the brief and land queue.planned', async () => {
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) {
        if (input.className === 'research') return { text: JSON.stringify(SCOUT_ANSWERS) };
        if (input.prompt.includes('already interviewed')) return { text: '# Goal: hide the empty row\n' };
        return { text: JSON.stringify(ONE_REPO_ONE_AARON) };
      },
    };
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-277');

    await runQueueTick(h.deps, [item]);
    expect(h.store.get(item.id)!.state).toBe('planning');

    const ask = asksForItem(h.inbox, item.id)[0]!;
    h.inbox.answer(ask.key, 'hide');

    await runQueueTick(h.deps, [h.store.get(item.id)!]);

    const after = h.store.get(item.id)!;
    expect(after.state).toBe('running');
    expect(after.briefPath).toBe('C:/briefs/BBZ-277.md');
    expect(h.events.filter((row) => row['event'] === 'queue.planned')).toHaveLength(1);
    expect(h.briefsWritten).toHaveLength(1);
    expect(h.briefsWritten[0]).toContain('# Goal:');
  });

  it('the brief prompt carries the answer a person typed and the one the scout found', async () => {
    const prompts: string[] = [];
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) {
        prompts.push(input.prompt);
        if (input.className === 'research') return { text: JSON.stringify(SCOUT_ANSWERS) };
        if (input.prompt.includes('already interviewed')) return { text: '# Goal: x\n' };
        return { text: JSON.stringify(ONE_REPO_ONE_AARON) };
      },
    };
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-277');
    await runQueueTick(h.deps, [item]);
    h.inbox.answer(asksForItem(h.inbox, item.id)[0]!.key, 'hide it entirely');
    await runQueueTick(h.deps, [h.store.get(item.id)!]);

    const briefPrompt = prompts.find((p) => p.includes('already interviewed'))!;
    expect(briefPrompt).toContain('hide it entirely');
    expect(briefPrompt).toContain('it reads data.vouchers');
    expect(briefPrompt).toContain('src/VoucherList.tsx:42');
  });

  it('a scout that cannot answer turns its own question into an ask with the note attached', async () => {
    const reasoner = scriptedReasoner([
      { route: 'frontend', questions: [ONE_REPO_ONE_AARON.questions[0]] },
      SCOUT_CANNOT_ANSWER,
    ]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-277');

    await runQueueTick(h.deps, [item]);

    const asks = asksForItem(h.inbox, item.id);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toContain('looked in the code first');
    expect(h.store.get(item.id)!.state).toBe('planning');
  });

  it('a backend-only ticket never launches a worker and raises no ask', async () => {
    const reasoner = scriptedReasoner([
      { route: 'backend', ask: 'The voucher endpoint returns null for an empty wallet.', questions: [] },
    ]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-900');

    await runQueueTick(h.deps, [item]);

    const after = h.store.get(item.id)!;
    expect(after.state).toBe('parked');
    expect(after.reason).toContain('backend');
    expect(after.reason).toContain('returns null for an empty wallet');
    expect(asksForItem(h.inbox, item.id)).toHaveLength(0);
    expect(h.events.some((row) => row['event'] === 'queue.planned')).toBe(false);
  });

  it('a held item costs no reasoner call on the ticks it spends waiting', async () => {
    const reasoner = scriptedReasoner([ONE_REPO_ONE_AARON, SCOUT_ANSWERS]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-277');

    await runQueueTick(h.deps, [item]);
    const afterFirst = reasoner.prompts.length;
    await runQueueTick(h.deps, [h.store.get(item.id)!]);
    await runQueueTick(h.deps, [h.store.get(item.id)!]);

    expect(reasoner.prompts).toHaveLength(afterFirst);
    // And the waiting row is written once, not once per tick.
    expect(h.events.filter((row) => row['event'] === 'queue.waiting')).toHaveLength(1);
  });
});
