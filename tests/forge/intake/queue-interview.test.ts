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
import { Inbox, isAskStale } from '../../../src/forge/inbox.js';
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

    // The scout answered the repo question outright, so only the operator's question
    // ever reached the inbox -- and only that one gets an `interview.asked` row.
    const asked = h.events.filter((row) => row['event'] === 'interview.asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]!['itemId']).toBe(item.id);
    expect(asked[0]!['ticket']).toBe('BBZ-277');
    expect(asked[0]!['askKey']).toBe(asks[0]!.key);
    expect(asked[0]!['answerableBy']).toBe('aaron');
    // What was asked, not only who owns it -- the comment above this row's write site
    // claims both, so both need to actually be there.
    expect(asked[0]!['question']).toContain('hide the row');
  });

  // Line-item finding: `inbox.raise` dedupes by askKey, so two questions that normalise
  // to the same key (identical text and options, same item, same actionTarget) leave one
  // entry on disk. The row must follow that -- one row, not two sharing an askKey.
  it('two questions that normalise to the same askKey write one interview.asked row, not two', async () => {
    const SAME_QUESTION_TWICE = {
      route: 'frontend',
      questions: [
        { text: 'same question, asked twice?', options: [], recommended: null, answerableBy: 'aaron' },
        { text: 'same question, asked twice?', options: [], recommended: null, answerableBy: 'aaron' },
      ],
    };
    const reasoner = scriptedReasoner([SAME_QUESTION_TWICE]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-400');

    await runQueueTick(h.deps, [item]);

    const asks = asksForItem(h.inbox, item.id);
    expect(asks).toHaveLength(1);
    const asked = h.events.filter((row) => row['event'] === 'interview.asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]!['askKey']).toBe(asks[0]!.key);
  });

  // A teammate-tagged question names who owns it; the row must carry that name, not just
  // 'teammate' as a category.
  it('a teammate-tagged ask carries who in its interview.asked row', async () => {
    const TEAMMATE_QUESTION = {
      route: 'frontend',
      questions: [
        { text: 'who owns the Slack bot token?', options: [], recommended: null, answerableBy: 'teammate', who: 'joe' },
      ],
    };
    const reasoner = scriptedReasoner([TEAMMATE_QUESTION]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-401');

    await runQueueTick(h.deps, [item]);

    const asked = h.events.filter((row) => row['event'] === 'interview.asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]!['who']).toBe('joe');
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
    // The "interview" reason belongs to the wait, not to the item: an item that moved on
    // still reading "interview" is the same staleness the after-gate reason already had
    // to be taught to clear.
    expect(after.reason).toBeNull();
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

    // A repo question the scout could not answer still becomes an ask, and the row it
    // writes says so -- `answerableBy` reads 'aaron', the reassigned owner, never 'repo'.
    const asked = h.events.filter((row) => row['event'] === 'interview.asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]!['answerableBy']).toBe('aaron');
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
    // A backend-routed ticket never reaches the ask loop at all, so no interview.asked
    // row gets written for it either.
    expect(h.events.some((row) => row['event'] === 'interview.asked')).toBe(false);
  });

  // Found by /critique, 2026-09-11. An interview ask names its item, not a launched
  // process, so no registry row will ever exist for it -- `isAskStale` read every one of
  // them as stale from birth, `forge status` filed them under "not worth your time", and
  // `forge clear --all` retired them, which silently restarted the interview and
  // abandoned any Slack thread already open on the question.
  it('an interview ask is never stale: it belongs to an item, not to a live process', async () => {
    const reasoner = scriptedReasoner([ONE_REPO_ONE_AARON, SCOUT_ANSWERS]);
    const h = harness(reasoner);
    const item = addTicketItem(h.store, 'BBZ-277');
    await runQueueTick(h.deps, [item]);

    const ask = asksForItem(h.inbox, item.id)[0]!;
    expect(ask.runs).toEqual([`item:${item.id}`]);
    // No run in this ask has a registry row, and it must still not read as stale.
    expect(isAskStale(ask, () => false)).toBe(false);
  });

  // Found by /critique, 2026-09-11. `QUEUE_IN_FLIGHT_STATES` counts `planning`, so a
  // held item used to eat a concurrency slot for as long as its question went
  // unanswered; enough of them starved every queued item behind them.
  it('a held item does not hold a concurrency slot against the queued items behind it', async () => {
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) {
        if (input.className === 'research') return { text: JSON.stringify(SCOUT_ANSWERS) };
        if (input.prompt.includes('BBZ-277')) return { text: JSON.stringify(ONE_REPO_ONE_AARON) };
        if (input.prompt.includes('already interviewed')) return { text: '# Goal: fix BBZ-500\n' };
        return { text: JSON.stringify({ route: 'frontend', questions: [] }) };
      },
    };
    const h = harness(reasoner);
    h.deps.maxInFlight = () => 1;

    const held = addTicketItem(h.store, 'BBZ-277');
    await runQueueTick(h.deps, [held]);
    expect(h.store.get(held.id)!.state).toBe('planning');
    expect(h.store.get(held.id)!.reason).toBe('interview');

    const behind = addTicketItem(h.store, 'BBZ-500');
    await runQueueTick(h.deps, [h.store.get(held.id)!, behind]);

    expect(h.store.get(behind.id)!.state).toBe('running');
  });

  it('a planning call that re-enters an item while its interview is still in flight costs no second interview (live 2026-09-11: four interviews per ticket)', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: string[] = [];
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) {
        prompts.push(input.prompt);
        await gate;
        return { text: JSON.stringify(ONE_REPO_ONE_AARON) };
      },
    };
    const inbox = tempInbox();
    const records = new MemoryInterviewStore();
    const deps = {
      reasoner, inbox, records,
      packetFor: async (ticket: string) => packetFor(ticket),
      scout: async () => ({ answered: true, text: 'found it', citation: 'a.ts:1' }),
      writeBriefFile: async () => ({ briefPath: 'C:/briefs/x.md', repo: 'owner/repo' }),
    };

    const first = planTicketWithInterview('BBZ-277', 'Q-1', deps);
    await new Promise((r) => setTimeout(r, 5));
    const second = await planTicketWithInterview('BBZ-277', 'Q-1', deps);

    expect(second).toEqual({ waiting: 'interview', asks: 0 });
    expect(prompts, 'the overlapping call must not start a second interview').toHaveLength(1);
    release!();
    const done = await first;
    expect('waiting' in done).toBe(true);
    expect(asksForItem(inbox, 'Q-1')).toHaveLength(1);
  });

  it('a lease older than the window does not block a fresh interview (a crashed process must not hold a ticket forever)', async () => {
    const reasoner = scriptedReasoner([ONE_REPO_ONE_AARON, SCOUT_ANSWERS]);
    const inbox = tempInbox();
    const records = new MemoryInterviewStore();
    records.put({ itemId: 'Q-2', ticket: 'BBZ-277', at: 1, answers: [], inFlightAt: 1 });
    const deps = {
      reasoner, inbox, records,
      packetFor: async (ticket: string) => packetFor(ticket),
      scout: async () => ({ answered: true, text: 'found it', citation: 'a.ts:1' }),
      writeBriefFile: async () => ({ briefPath: 'C:/briefs/x.md', repo: 'owner/repo' }),
    };
    const out = await planTicketWithInterview('BBZ-277', 'Q-2', deps);
    expect('waiting' in out).toBe(true);
    expect(reasoner.prompts.length).toBeGreaterThan(0);
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
    // A held item's ask was raised once, on the first tick; the ticks it spends waiting
    // never re-raise it, so no repeat interview.asked row appears.
    expect(h.events.filter((row) => row['event'] === 'interview.asked')).toHaveLength(1);
  });
});
