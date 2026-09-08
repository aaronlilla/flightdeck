/**
 * The Conductor agent (`src/forge/console/agent.ts`), driven end to end against a real
 * `ForgeServer` with a scripted fake `query` (`agent-fake.ts`). Every tool call the
 * script makes runs through the agent's real MCP server and the real function behind
 * the tool; the only thing faked is the model.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Actuator, DecisionId, RunId } from '../../../src/forge/contracts.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Journal, appendOnce, replay } from '../../../src/forge/journal.js';
import { Registry } from '../../../src/forge/registry.js';
import { Lanes } from '../../../src/forge/supervisor.js';
import { ForgeServer } from '../../../src/forge/server.js';
import { INHERITED } from '../../../src/forge/worker.js';
import { modelFor, modelIdFor } from '../../../src/forge/policy.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { readRetired, retiredPath } from '../../../src/forge/console/retire.js';
import { readCapsOverrides } from '../../../src/forge/console/caps-read.js';
import { ConductorAgent, conductorStateSummary } from '../../../src/forge/console/agent.js';
import { CONDUCTOR_TOOL_NAMES, IRREVERSIBLE_TOOLS, type ConductorToolName } from '../../../src/forge/console/agent-tools.js';
import { ConsoleWrites } from '../../../src/forge/console/command.js';
import type { Message } from '../../../src/shared/console-model.js';
import { hangingQuery, refusingQuery, scriptedQuery, type ScriptedTurn } from './agent-fake.js';

class FakeActuator implements Actuator {
  parked: string[] = [];

  resumed: string[] = [];

  killed: string[] = [];

  constructor(private readonly journalPath: string) {}

  async park(run: RunId, reason: string): Promise<boolean> {
    this.parked.push(run);
    appendOnce(this.journalPath, { event: 'run.parked', run, actor: 'warden', reason });
    return true;
  }

  async nudge(): Promise<void> {}

  async resume(run: RunId): Promise<void> {
    this.resumed.push(run);
    appendOnce(this.journalPath, { event: 'run.resumed', run, actor: 'warden' });
  }

  async kill(run: RunId, _decisionId: DecisionId): Promise<void> {
    this.killed.push(run);
    appendOnce(this.journalPath, { event: 'run.killed', run, actor: 'warden' });
  }
}

const DEAD = '2026-09-04-acme-c2-rn';

let dir: string;
let journalPath: string;
let actuator: FakeActuator;
let server: ForgeServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-conductor-'));
  process.env['FORGE_HOME'] = dir;
  journalPath = join(dir, 'fleet.jsonl');
  new Journal(journalPath).close();
  actuator = new FakeActuator(journalPath);
  // A generous hard limit so a proposed run cap is refused for no reason but its own.
  writeFileSync(join(dir, 'console', 'caps.json').replace(/[/\\]console[/\\]caps\.json$/, ''), '', { flag: 'a' });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** The mission lane: a manual run that ended `unverified` with no live process. */
function deadLane(id = DEAD): void {
  const journal = new Journal(journalPath);
  journal.append({ event: 'run.started', run: id, actor: 'runner' });
  journal.append({ event: 'run.finished', run: id, verdict: 'unverified' });
  journal.close();
}

/** A live lane: a lane record, a registry row for this very process, one turn taken. */
function liveLane(id: string): void {
  new Lanes(join(dir, 'lanes')).put(id, { column: 'c', model: 'claude-sonnet-5', context: 1000, cost_usd: 0, session_id: 's1' });
  writeFileSync(join(dir, `${id}.md`), `# ${id}\n\n## Definition of Done\n\n- ship it\n`, 'utf8');
  new Registry(join(dir, 'registry')).admit({ goal: id, cwd: dir, briefPath: join(dir, `${id}.md`), pid: process.pid });
  const journal = new Journal(journalPath);
  journal.append({ event: 'run.started', run: id, actor: 'runner' });
  journal.close();
}

function makeServer(queryFn: Parameters<typeof scriptedQuery>[0] | ReturnType<typeof scriptedQuery>['fn'], extra: { idleMs?: number } = {}): ForgeServer {
  const fn = typeof queryFn === 'function' ? queryFn : scriptedQuery(queryFn).fn;
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')), journalPath,
    registry: new Registry(join(dir, 'registry')), port: 0, consoleActuator: actuator,
    queueStore: new QueueStore(join(dir, 'queue.jsonl')),
    conductorQueryFn: fn, ...(extra.idleMs !== undefined ? { conductorIdleMs: extra.idleMs } : {}),
  });
  return server;
}

function confirmToken(card: Message): string {
  return card.btns!.find((btn) => btn.cmd.startsWith('confirm ') || btn.cmd.startsWith('run '))!.cmd.split(' ')[1]!;
}

function inboxFiles(run: string): number {
  try {
    return readdirSync(join(dir, 'runs', run, 'inbox')).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

async function command(text: string, run?: string): Promise<Message[]> {
  const base = `http://127.0.0.1:${await server!.listen()}`;
  const response = await fetch(`${base}/command`, {
    method: 'POST', headers: { 'x-forge-token': server!.token, 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(run ? { run } : {}) }),
  });
  return ((await response.json()) as { cards: Message[] }).cards;
}

describe('ConductorAgent: the mission, on a fake model and a real board', () => {
  it('"remove <dead lane>" -> a retire tool call -> a server-side pending confirm, a card in the reply, nothing written until confirm', async () => {
    deadLane();
    const fake = scriptedQuery([{ tools: [{ tool: 'retire', input: { lane: DEAD } }], reply: 'Proposed taking it off the board; the Confirm card is waiting for you.' }]);
    makeServer(fake.fn);
    const reply = await server!.conductor.handle(`remove ${DEAD}`);

    expect(reply.path).toBe('agent');
    expect(fake.toolCalls.map((call) => call.tool)).toEqual(['retire']);
    expect(fake.toolCalls[0]!.result).toMatch(/waiting on Confirm/);
    const replyRow = reply.cards.find((card) => card.type === 'reply')!;
    expect(replyRow.path).toBe('agent');
    const card = reply.cards.find((card) => card.type === 'confirm')!;
    expect(card, 'the reply carries the confirm card').toBeDefined();
    expect(existsSync(retiredPath(dir))).toBe(false);
    expect(replay(journalPath).events.some((row) => row.event === 'lane.retired')).toBe(false);

    const after = await command(`confirm ${confirmToken(card)}`);
    expect(after.find((row) => row.type === 'receipt')?.text).toMatch(/retired/);
    expect([...readRetired(retiredPath(dir)).keys()]).toEqual([DEAD]);
    expect(replay(journalPath).events.some((row) => row.event === 'lane.retired' && row['run'] === DEAD)).toBe(true);
    // The confirm never reached the model: still one prompt, the original message.
    expect(fake.prompts).toHaveLength(1);
  });

  it('"kill and remove this" from a sheet on an unverified lane -> kill with andRetire -> one card, both run on confirm', async () => {
    deadLane();
    const fake = scriptedQuery([{ tools: [{ tool: 'kill', input: { lane: DEAD, andRetire: true } }], reply: 'Kill and remove proposed; confirm when ready.' }]);
    makeServer(fake.fn);
    const reply = await server!.conductor.handle('kill and remove this', { run: DEAD });

    expect(fake.prompts[0]).toMatch(new RegExp(`operator has this lane's sheet open: ${DEAD}`));
    const cards = reply.cards.filter((card) => card.type === 'confirm');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.blast).toMatch(/stops now and leaves the board/);
    expect(actuator.killed).toEqual([]);
    expect(existsSync(retiredPath(dir))).toBe(false);

    const after = await command(`confirm ${confirmToken(cards[0]!)}`);
    expect(actuator.killed).toEqual([DEAD]);
    expect([...readRetired(retiredPath(dir)).keys()]).toEqual([DEAD]);
    expect(after.filter((row) => row.type === 'receipt').map((row) => row.text)).toEqual(expect.arrayContaining([
      expect.stringMatching(/kill/), expect.stringMatching(/retired/),
    ]));
    // The exchange landed in the run's own thread as well as the rail.
    const runRows = replay(journalPath).events.filter((row) => row.event === 'conductor.receipt' && row['run'] === DEAD);
    expect(runRows.map((row) => row['kind'])).toEqual(expect.arrayContaining(['receipt', 'reply']));
  });

  it('"what\'s going on with <lane>" -> lane_detail -> a reply quoting the gate log, no action proposed', async () => {
    liveLane('alpha');
    const fake = scriptedQuery([{ tools: [{ tool: 'lane_detail', input: { lane: 'alpha' } }], reply: (results) => `Here is what I see:\n${results[0]}` }]);
    makeServer(fake.fn);
    const reply = await server!.conductor.handle("what's going on with alpha");

    expect(fake.toolCalls.map((call) => call.tool)).toEqual(['lane_detail']);
    const replyRow = reply.cards.find((card) => card.type === 'reply')!;
    expect(replyRow.text).toMatch(/gate log:/);
    expect(replyRow.text).toMatch(/alpha \(alpha\) is running/);
    expect(reply.cards.some((card) => card.type === 'confirm' || card.type === 'plan')).toBe(false);
    expect(server!.conductor.currentSessionId).toBe('conductor-fake-session');
  });

  it('a session that cannot open -> the grammar answers and the reply names the fallback and the reason', async () => {
    deadLane();
    makeServer(refusingQuery('fleet login expired').fn);
    const reply = await server!.conductor.handle(`remove ${DEAD}`);

    expect(reply.path).toBe('grammar');
    expect(reply.reason).toBe('fleet login expired');
    expect(reply.cards[0]!.type).toBe('reply');
    expect(reply.cards[0]!.path).toBe('grammar');
    expect(reply.cards[0]!.text).toBe('The Conductor could not answer (fleet login expired). The grammar answered instead:');
    // The grammar's own retire card follows, so the operator still gets somewhere.
    const card = reply.cards.find((row) => row.type === 'confirm')!;
    expect(card.path).toBe('grammar');
    expect(card.blast).toMatch(/leaves the board/);
  });

  it('a session that never answers -> the timeout names the class budget and the grammar answers', async () => {
    deadLane();
    const hang = hangingQuery();
    const fired: Array<() => void> = [];
    const setTimeoutFn = ((cb: () => void) => { fired.push(cb); return fired.length as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout;
    const agent = new ConductorAgent({
      writes: new ConsoleWrites({
        journalPath, registry: new Registry(join(dir, 'registry')), inbox: new Inbox(join(dir, 'inbox')), actuator,
        authorized: () => true, forgeHomeDir: dir,
      }),
      reads: fakeReads(), queue: fakeQueue(), amend: { registry: new Registry(join(dir, 'registry')), journalPath, publish: () => {} },
      inbox: new Inbox(join(dir, 'inbox')), journalPath, publish: () => {}, queryFn: hang.fn,
      setTimeoutFn, clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
    });
    const pending = agent.handle('status');
    // Fire the class timeout by hand rather than waiting 120s for it.
    await new Promise((resolve) => setImmediate(resolve));
    fired[0]!();
    const reply = await pending;
    expect(reply.path).toBe('grammar');
    expect(reply.cards[0]!.text).toMatch(/did not answer in 120s/);
    expect(reply.cards[1]!.type).toBe('reply');
    await agent.stop();
  });

  it('the SDK env carries CLAUDE_CONFIG_DIR = the fleet dir and none of the parent\'s CLAUDE_* markers; the model is the implement class on Sonnet', async () => {
    const fake = scriptedQuery([{ reply: 'hello' }]);
    const parentEnv: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: dir };
    for (const name of INHERITED) parentEnv[name] = 'leak';
    parentEnv['ANTHROPIC_API_KEY'] = 'leak';
    const agent = new ConductorAgent({
      writes: new ConsoleWrites({
        journalPath, registry: new Registry(join(dir, 'registry')), inbox: new Inbox(join(dir, 'inbox')), actuator,
        authorized: () => true, forgeHomeDir: dir,
      }),
      reads: fakeReads(), queue: fakeQueue(), amend: { registry: new Registry(join(dir, 'registry')), journalPath, publish: () => {} },
      inbox: new Inbox(join(dir, 'inbox')), journalPath, publish: () => {}, queryFn: fake.fn,
      env: parentEnv, existsConfigDir: (path) => path.endsWith('.claude-fleet'),
    });
    await agent.handle('hello');
    const options = fake.calls[0]!.options;
    const env = options.env as NodeJS.ProcessEnv;
    expect(env['CLAUDE_CONFIG_DIR']).toMatch(/\.claude-fleet$/);
    for (const name of INHERITED) expect(env[name], name).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(options.model).toBe(modelIdFor(modelFor('implement')));
    expect(options.model).toMatch(/sonnet/);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toContain('mcp__conductor__kill');
    expect(options.settingSources).toEqual([]);
    expect((options.mcpServers as Record<string, unknown>)['conductor']).toBeDefined();
    await agent.stop();
  });

  it('every reply and receipt lands in thread.jsonl, and a conductor.usage row with the account is journaled per turn', async () => {
    liveLane('alpha');
    const fake = scriptedQuery([{ tools: [{ tool: 'pause', input: { lane: 'alpha' } }], reply: 'Paused alpha.', usage: { input: 300, cacheRead: 20, cacheCreation: 10, output: 50 } }]);
    makeServer(fake.fn);
    await server!.conductor.handle('pause alpha');
    const thread = readFileSync(join(dir, 'console', 'thread.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Message);
    expect(thread.map((row) => row.type)).toEqual(['receipt', 'reply']);
    const usage = replay(journalPath).events.find((row) => row.event === 'conductor.usage')!;
    expect(usage).toBeDefined();
    expect(usage['usage']).toEqual({ input: 600, cacheRead: 40, cacheCreation: 20, output: 100 });
    expect(usage['class']).toBe('implement');
    expect(typeof usage['account']).toBe('string');
    expect(usage['sessionId']).toBe('conductor-fake-session');
  });

  it('at the class ceiling the session is dropped, the reply says so, and the next message opens fresh with a handoff paragraph', async () => {
    const fake = scriptedQuery([{ reply: 'Big turn.', usage: { input: 150_000, cacheRead: 0, cacheCreation: 0, output: 10 } }, { reply: 'Fresh.' }]);
    makeServer(fake.fn);
    const first = await server!.conductor.handle('status');
    expect(first.cards.map((card) => card.text)).toContain('That session reached its context ceiling; a fresh one takes over from here carrying a short summary of what we were doing.');
    expect(server!.conductor.open).toBe(false);
    await server!.conductor.handle('and now?');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.options.resume).toBeUndefined();
    expect(fake.prompts[1]).toMatch(/<handoff>[\s\S]*operator: status \/ conductor: Big turn\.[\s\S]*<\/handoff>/);
  });

  it('after the idle window the subprocess closes and the next message resumes the same session id', async () => {
    const fake = scriptedQuery([{ reply: 'one' }, { reply: 'two' }]);
    const idle: Array<() => void> = [];
    makeServer(fake.fn, { idleMs: 1 });
    // Replace the timer seam so the idle close fires on demand.
    const agent = server!.conductor as unknown as { deps: { setTimeoutFn?: typeof setTimeout } };
    agent.deps.setTimeoutFn = ((cb: () => void) => { idle.push(cb); return 1 as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout;
    await server!.conductor.handle('first');
    expect(server!.conductor.open).toBe(true);
    idle[idle.length - 1]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server!.conductor.open).toBe(false);
    await server!.conductor.handle('second');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.options.resume).toBe('conductor-fake-session');
  });
});

describe('send_to_run goes through assertRunListening', () => {
  it('a run with no record -> W1\'s reason, no inbox file', async () => {
    const fake = scriptedQuery([{ tools: [{ tool: 'send_to_run', input: { lane: 'ghost', text: 'hi' } }], reply: 'Refused.' }]);
    makeServer(fake.fn);
    await server!.conductor.handle('tell ghost hi');
    expect(fake.toolCalls[0]!.result).toMatch(/refused: ghost has no live session; nothing on the board runs it/);
    expect(inboxFiles('ghost')).toBe(0);
  });

  it('a record with heart false -> W1\'s reason with the end time, no inbox file', async () => {
    deadLane();
    const fake = scriptedQuery([{ tools: [{ tool: 'send_to_run', input: { lane: DEAD, text: 'kill and remove this' } }], reply: 'Refused.' }]);
    makeServer(fake.fn);
    await server!.conductor.handle('tell it to stop', { run: DEAD });
    expect(fake.toolCalls[0]!.result).toMatch(new RegExp(`refused: ${DEAD} has no live session; it ended`));
    expect(inboxFiles(DEAD)).toBe(0);
  });

  it('a live run -> the inbox file exists', async () => {
    liveLane('alpha');
    const fake = scriptedQuery([{ tools: [{ tool: 'send_to_run', input: { lane: 'alpha', text: 'status?' } }], reply: 'Sent.' }]);
    makeServer(fake.fn);
    await server!.conductor.handle('ask alpha for status');
    expect(fake.toolCalls[0]!.result).toBe('sent to alpha');
    expect(inboxFiles('alpha')).toBe(1);
  });
});

/** What each tool must observably do through the real function behind it. `before`
 *  is asserted after the tool ran and before any confirm (for an irreversible tool it
 *  proves the mutation is absent); `after` is asserted once `confirm <token>` ran. */
interface ToolSpec {
  setup?: () => void;
  input: Record<string, unknown>;
  resultMatches: RegExp;
  before?: () => void;
  after?: () => void;
}

function fakeReads() {
  const empty = { at: Date.now(), lanes: [], tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } };
  return {
    lanesResponse: () => empty,
    runThread: () => ({ messages: [] }),
    runStory: async () => ({ id: 'x', title: null, kind: 'manual' as const, ticket: null, brief: null, entries: [] }),
    runSummaryResponse: async () => ({ what: [], status: 'x', next: 'x', audit: null, readiness: null }),
    runRecheckResponse: async () => ({ what: [], status: 'x', next: 'x', audit: null, readiness: null }),
  };
}

function fakeQueue() {
  return {
    list: () => ({ items: [], paused: false, maxInFlight: 2 }),
    addItems: async () => ({ ok: true as const, items: [] }),
    remove: () => ({ ok: true, jid: null, message: 'removed', undoable: false }),
    retry: () => ({ ok: true, jid: null, message: 'retried', undoable: false }),
  };
}

describe('every Conductor tool calls its named existing function; the six irreversibles wait for confirm', () => {
  const specs: Record<ConductorToolName, ToolSpec> = {
    list_lanes: {
      setup: () => liveLane('alpha'), input: {},
      resultMatches: /lanes \(1\):\n- id=alpha .*state=running heart=live/,
    },
    lane_detail: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha' },
      resultMatches: /alpha \(alpha\) is running[\s\S]*gate log:[\s\S]*recent thread:/,
    },
    pause: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha' },
      resultMatches: /paused/,
      before: () => { expect(actuator.parked).toEqual(['alpha']); expect(replay(journalPath).events.some((row) => row.event === 'run.parked' && row['run'] === 'alpha')).toBe(true); },
    },
    resume: {
      setup: () => { liveLane('alpha'); appendOnce(journalPath, { event: 'run.paused', run: 'alpha', actor: 'runner' }); },
      input: { lane: 'alpha' }, resultMatches: /resumed/,
      before: () => { expect(actuator.resumed).toEqual(['alpha']); },
    },
    kill: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha', reason: 'operator asked' },
      resultMatches: /kill proposed for alpha, waiting on Confirm/,
      before: () => { expect(actuator.killed).toEqual([]); expect(replay(journalPath).events.some((row) => row.event === 'decision.made')).toBe(false); },
      after: () => { expect(actuator.killed).toEqual(['alpha']); expect(replay(journalPath).events.some((row) => row.event === 'decision.made' && row['run'] === 'alpha')).toBe(true); },
    },
    retire: {
      setup: () => deadLane(), input: { lane: DEAD },
      resultMatches: /remove proposed for .*, waiting on Confirm/,
      before: () => { expect(existsSync(retiredPath(dir))).toBe(false); },
      after: () => { expect([...readRetired(retiredPath(dir)).keys()]).toEqual([DEAD]); expect(replay(journalPath).events.some((row) => row.event === 'lane.retired')).toBe(true); },
    },
    unretire: {
      setup: () => { deadLane(); writeFileSync(retiredPath(dir).replace(/retired\.jsonl$/, ''), '', { flag: 'a' }); },
      input: { lane: DEAD }, resultMatches: new RegExp(`unretired ${DEAD}`),
      before: () => { expect(readRetired(retiredPath(dir)).has(DEAD)).toBe(false); expect(replay(journalPath).events.some((row) => row.event === 'lane.retired' && row['retired'] === false)).toBe(true); },
    },
    reopen: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha' },
      // reopenRun's own state rule answers: proof the call reached run-actions.ts.
      resultMatches: /refused: reopen needs killed\/blocked\/exhausted, not running/,
    },
    recheck: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha' },
      resultMatches: /rechecked alpha: /,
    },
    reaudit: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha' },
      // reauditRun's own refusal for a lane with no queue item and no PR.
      resultMatches: /refused: /,
    },
    merge_ready: {
      input: {}, resultMatches: /Nothing is ready to merge\./,
    },
    send_to_run: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha', text: 'carry on' },
      resultMatches: /sent to alpha/, before: () => { expect(inboxFiles('alpha')).toBe(1); },
    },
    amend_run: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha', text: 'also update the docs' },
      resultMatches: /amended alpha/,
      before: () => {
        expect(readFileSync(join(dir, 'alpha.md'), 'utf8')).toMatch(/## Amendment/);
        expect(replay(journalPath).events.some((row) => row.event === 'brief.amended' && row['run'] === 'alpha')).toBe(true);
        expect(inboxFiles('alpha')).toBe(1);
      },
    },
    answer_ask: {
      setup: () => {
        liveLane('alpha');
        new Inbox(join(dir, 'inbox')).ask({ runs: ['alpha'], question: 'Restart the forge MCP connection?', options: ['Restart', 'Skip'], kind: 'question' } as never);
      },
      input: { text: 'Restart' }, resultMatches: /Answered "Restart the forge MCP connection\?": Restart/,
      before: () => { expect(new Inbox(join(dir, 'inbox')).open()).toHaveLength(0); },
    },
    set_daily_cap: {
      input: { tokens: 250_000 }, resultMatches: /daily cap of 250k tokens proposed, waiting on Confirm/,
      before: () => { expect(readCapsOverrides(join(dir, 'console', 'caps.json')).dailyTokens).toBeUndefined(); },
      after: () => { expect(readCapsOverrides(join(dir, 'console', 'caps.json')).dailyTokens).toBe(250_000); },
    },
    set_run_cap: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha', tokens: 50_000 },
      resultMatches: /cap of 50k tokens proposed for alpha, waiting on Confirm/,
      before: () => { expect(readCapsOverrides(join(dir, 'console', 'caps.json')).runCaps?.['alpha']).toBeUndefined(); },
      after: () => { expect(readCapsOverrides(join(dir, 'console', 'caps.json')).runCaps?.['alpha']).toBe(50_000); },
    },
    spend_today: { input: {}, resultMatches: /spent 0 tokens today/ },
    what_stuck: { input: {}, resultMatches: /Nothing is stuck\./ },
    why_stuck: {
      setup: () => liveLane('alpha'), input: { lane: 'alpha' },
      resultMatches: /alpha is running/,
    },
    queue_list: {
      setup: () => { new QueueStore(join(dir, 'queue.jsonl')).append({ id: 'q1', at: 1, source: 'ticket', input: 'ACME-1', ticket: 'ACME-1', state: 'queued', createdAt: 1, updatedAt: 1 } as never); },
      input: {}, resultMatches: /queue is running, 1 item\(s\)[\s\S]*id=q1 state=queued source=ticket ACME-1/,
    },
    queue_add: {
      input: { source: 'ticket', input: 'ACME-7' }, resultMatches: /queued 1 item\(s\) from ticket/,
      before: () => { expect(new QueueStore(join(dir, 'queue.jsonl')).all().map((item) => item.ticket)).toEqual(['ACME-7']); },
    },
    queue_remove: {
      setup: () => { new QueueStore(join(dir, 'queue.jsonl')).append({ id: 'q1', at: 1, source: 'ticket', input: 'ACME-1', ticket: 'ACME-1', state: 'queued', createdAt: 1, updatedAt: 1 } as never); },
      input: { id: 'q1' }, resultMatches: /queue remove proposed for q1, waiting on Confirm/,
      before: () => { expect(new QueueStore(join(dir, 'queue.jsonl')).all().map((item) => item.state)).toEqual(['queued']); },
      after: () => { expect(new QueueStore(join(dir, 'queue.jsonl')).all().filter((item) => item.state === 'queued')).toHaveLength(0); },
    },
    queue_retry: {
      setup: () => { new QueueStore(join(dir, 'queue.jsonl')).append({ id: 'q1', at: 1, source: 'ticket', input: 'ACME-1', ticket: 'ACME-1', state: 'failed', reason: 'boom', createdAt: 1, updatedAt: 1 } as never); },
      input: { id: 'q1' }, resultMatches: /q1 is queued again/,
      before: () => { expect(new QueueStore(join(dir, 'queue.jsonl')).all().map((item) => item.state)).toEqual(['queued']); },
    },
  };

  it('the spec table covers exactly the tools the server registers', () => {
    expect(Object.keys(specs).sort()).toEqual([...CONDUCTOR_TOOL_NAMES].sort());
    expect(CONDUCTOR_TOOL_NAMES).toHaveLength(23);
  });

  for (const name of CONDUCTOR_TOOL_NAMES) {
    it(`${name}: calls its function${IRREVERSIBLE_TOOLS.includes(name) ? ', and mutates only after confirm' : ''}`, async () => {
      const spec = specs[name];
      spec.setup?.();
      const script: ScriptedTurn[] = [{ tools: [{ tool: name, input: spec.input }], reply: 'ok' }];
      const fake = scriptedQuery(script);
      makeServer(fake.fn);
      const reply = await server!.conductor.handle(`use ${name}`);
      expect(reply.path).toBe('agent');
      expect(fake.toolCalls[0]!.result).toMatch(spec.resultMatches);
      spec.before?.();
      if (IRREVERSIBLE_TOOLS.includes(name)) {
        const card = reply.cards.find((row) => row.type === 'confirm' || row.type === 'plan');
        if (name === 'merge_ready') {
          // Nothing ready on this board, so there is nothing to propose: the real
          // intent said so and no card exists to run.
          expect(card).toBeUndefined();
          return;
        }
        expect(card, `${name} must answer with a confirm card`).toBeDefined();
        await command(`confirm ${confirmToken(card!)}`);
        spec.after?.();
      } else {
        expect(reply.cards.some((row) => row.type === 'confirm' || row.type === 'plan')).toBe(false);
      }
    });
  }
});

describe('conductorStateSummary', () => {
  it('reduces each lane to its label, state, heart, kind, PR and a capped reason, and names the open sheet', () => {
    const text = conductorStateSummary({
      lanes: [{
        id: 'queue-ACME-9', ticket: 'ACME-9', title: 'a long title', state: 'blocked', heart: false, kind: 'queue',
        pr: { no: 12, url: 'u', merged: false }, reason: 'x'.repeat(300),
      } as never],
      asks: [{ key: 'ask1', question: 'Merge?', runs: ['queue-ACME-9'] }],
      sheetLane: 'queue-ACME-9', tokensToday: 12_345,
    });
    expect(text).toContain('- id=queue-ACME-9 label="ACME-9" state=blocked heart=none kind=queue pr=#12 reason="' + 'x'.repeat(140) + '"');
    expect(text).toContain('- key=ask1 runs=queue-ACME-9 question="Merge?"');
    expect(text).toContain("operator has this lane's sheet open: queue-ACME-9");
    expect(text).toContain('spent today: 12.3k tokens');
  });
});
