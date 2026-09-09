import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Actuator, DecisionId, RunId } from '../../../src/forge/contracts.js';
import { appendOnce, replay } from '../../../src/forge/journal.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Registry } from '../../../src/forge/registry.js';
import { ConsoleWrites, parseIntent } from '../../../src/forge/console/command.js';
import { tokensToday } from '../../../src/forge/console/lanes.js';
import { readRetired, retiredPath } from '../../../src/forge/console/retire.js';
import { fmtTokens } from '../../../src/shared/format-tokens.js';

class FakeActuator implements Actuator {
  parked: string[] = [];

  resumed: string[] = [];

  killed: string[] = [];

  constructor(private readonly journalPath: string) {}

  // Mirrors WardenActuator's own journal rows (warden.ts's park/resume/kill), since the
  // guard run-actions.ts now checks reads a run's state off the journal: a fake that
  // wrote nothing would leave every run "running" forever, no matter what this actuator
  // was just asked to do.
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

function fakeRequest(method: string, body?: unknown): IncomingMessage {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const request = {
    method,
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return request;
    },
  } as unknown as IncomingMessage;
  setImmediate(() => {
    if (body !== undefined) (listeners['data'] ?? []).forEach((cb) => cb(Buffer.from(JSON.stringify(body))));
    (listeners['end'] ?? []).forEach((cb) => cb());
  });
  return request;
}

function fakeResponse(): { response: ServerResponse; result: Promise<{ status: number; body: unknown }> } {
  let resolveResult: (value: { status: number; body: unknown }) => void;
  const result = new Promise<{ status: number; body: unknown }>((resolve) => { resolveResult = resolve; });
  let status = 0;
  const response = {
    writeHead(code: number) { status = code; return response; },
    end(text?: string) { resolveResult({ status, body: text ? JSON.parse(text) : undefined }); },
  } as unknown as ServerResponse;
  return { response, result };
}

describe('parseIntent', () => {
  it('parses every documented intent shape', () => {
    expect(parseIntent('pause')).toEqual({ kind: 'pause' });
    expect(parseIntent('pause everything on acme/widget')).toEqual({ kind: 'pause', repo: 'acme/widget' });
    expect(parseIntent('resume')).toEqual({ kind: 'resume' });
    expect(parseIntent('kill FLT-204')).toEqual({ kind: 'kill', lane: 'FLT-204' });
    expect(parseIntent('merge ready lanes')).toEqual({ kind: 'merge-ready' });
    expect(parseIntent('raise daily cap to 500000')).toEqual({ kind: 'set-daily-cap', amount: 500_000 });
    expect(parseIntent('set daily cap to 500k')).toEqual({ kind: 'set-daily-cap', amount: 500_000 });
    expect(parseIntent('cap FLT-204 at 50000')).toEqual({ kind: 'set-run-cap', lane: 'FLT-204', amount: 50_000 });
    expect(parseIntent("why is lane FLT-1 stuck")).toEqual({ kind: 'why-stuck', lane: 'FLT-1' });
    expect(parseIntent("what's stuck")).toEqual({ kind: 'what-stuck' });
    expect(parseIntent('spend today')).toEqual({ kind: 'spend-today' });
    expect(parseIntent('status')).toEqual({ kind: 'status' });
    expect(parseIntent('answer backfill')).toEqual({ kind: 'answer', askKey: null, text: 'backfill' });
    expect(parseIntent('answer f92af4249f6a27ae Restart the forge MCP connection'))
      .toEqual({ kind: 'answer', askKey: 'f92af4249f6a27ae', text: 'Restart the forge MCP connection' });
    expect(parseIntent('confirm abc123')).toEqual({ kind: 'confirm', token: 'abc123' });
    expect(parseIntent('run abc123')).toEqual({ kind: 'run-plan', token: 'abc123' });
    expect(parseIntent('dismiss abc123')).toEqual({ kind: 'dismiss', token: 'abc123' });
    expect(parseIntent('gibberish')).toEqual({ kind: 'unknown', text: 'gibberish' });
  });

  // W1: the mission lane was unverified with no PR and no heart, and the operator typed
  // "remove 2026-09-04-forge-c2-rn" three times and got "I did not understand that"
  // each time -- remove/archive/retire are three spellings of the same intent, and
  // reopen/verify complete the set of actions a lane's own REST route already supports
  // but the grammar never offered a person typing plain text.
  it('parses remove/archive/retire as one retire intent, and reopen/verify', () => {
    expect(parseIntent('remove 2026-09-04-forge-c2-rn')).toEqual({ kind: 'retire', lane: '2026-09-04-forge-c2-rn' });
    expect(parseIntent('archive 2026-09-04-forge-c2-rn')).toEqual({ kind: 'retire', lane: '2026-09-04-forge-c2-rn' });
    expect(parseIntent('retire 2026-09-04-forge-c2-rn')).toEqual({ kind: 'retire', lane: '2026-09-04-forge-c2-rn' });
    expect(parseIntent('reopen FLT-204')).toEqual({ kind: 'reopen', lane: 'FLT-204' });
    expect(parseIntent('verify FLT-204')).toEqual({ kind: 'verify', lane: 'FLT-204' });
  });
});

let dir: string;
let journalPath: string;
let registry: Registry;
let inbox: Inbox;
let actuator: FakeActuator;
let writes: ConsoleWrites;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-command-'));
  // `appendThread` writes through `consoleDir()`, which follows `FORGE_HOME` like every
  // other Forge path -- without this the thread test would append to this machine's
  // real `~/.forge/console/thread.jsonl` instead of the fixture.
  process.env['FORGE_HOME'] = dir;
  journalPath = join(dir, 'fleet.jsonl');
  registry = new Registry(join(dir, 'registry'));
  inbox = new Inbox(join(dir, 'inbox'));
  actuator = new FakeActuator(journalPath);
  writes = new ConsoleWrites({
    journalPath, registry, inbox, actuator,
    authorized: () => true,
    ledgerPath: join(dir, 'actions.jsonl'),
    capsOverridesPath: join(dir, 'caps.json'),
    rulesConfigPath: join(dir, 'rules.json'),
    integrationsConfigPath: join(dir, 'integrations.json'),
  });
});

describe('ConsoleWrites.handle', () => {
  it('returns false for a path it does not own', async () => {
    const { response } = fakeResponse();
    const handled = await writes.handle('/state', fakeRequest('GET'), response);
    expect(handled).toBe(false);
  });

  it('kills a run through POST /run/:id/kill', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    const { response, result } = fakeResponse();

    const handled = await writes.handle('/run/alpha/kill', fakeRequest('POST', { reason: 'stop' }), response);

    expect(handled).toBe(true);
    // Kill is irreversible: the first call registers a server-side confirm and answers
    // 202 with the token; nothing is killed until that token comes back.
    const pending = await result;
    expect(pending.status).toBe(202);
    expect(actuator.killed).toEqual([]);
    const token = (pending.body as { token: string }).token;
    expect(writes.hasPending(token)).toBe(true);

    const second = fakeResponse();
    await writes.handle('/run/alpha/kill', fakeRequest('POST', { reason: 'stop', confirm: token }), second.response);
    const outcome = await second.result;
    expect(outcome.status).toBe(200);
    expect(actuator.killed).toEqual(['alpha']);
    expect(writes.hasPending(token)).toBe(false);
  });

  it('a stale confirm token is refused with 409 and kills nothing', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    const { response, result } = fakeResponse();
    await writes.handle('/run/alpha/kill', fakeRequest('POST', { reason: 'stop', confirm: 'never-issued' }), response);
    expect((await result).status).toBe(409);
    expect(actuator.killed).toEqual([]);
  });

  it('refuses a run cap above the hard limit with 422', async () => {
    writeFileSync(join(dir, 'caps.json'), JSON.stringify({ hardTokens: 100_000 }), 'utf8');
    const { response, result } = fakeResponse();

    await writes.handle('/run/alpha/cap', fakeRequest('POST', { tokenCap: 999_999 }), response);

    const outcome = await result;
    expect(outcome.status).toBe(422);
  });

  // Pause used to be the undoable action exercised here, but it never actually
  // suspended a run (see run-actions.ts's own doc on `pauseRun`) and now answers 501
  // honestly instead of recording an undoable action at all. A per-run cap override is
  // still genuinely undoable, so it stands in for exercising the generic
  // POST /journal/:jid/undo endpoint here.
  it('undoes a run-cap override through POST /journal/:jid/undo', async () => {
    const capResponse = fakeResponse();
    await writes.handle('/run/alpha/cap', fakeRequest('POST', { tokenCap: 5 }), capResponse.response);
    const capped = await capResponse.result;
    const jid = (capped.body as { jid: string }).jid;

    const undoResponse = fakeResponse();
    const handled = await writes.handle(`/journal/${jid}/undo`, fakeRequest('POST'), undoResponse.response);
    const undone = await undoResponse.result;

    expect(handled).toBe(true);
    expect(undone.status).toBe(200);
  });

  it('refuses a second undo of the same jid with 409', async () => {
    const capResponse = fakeResponse();
    await writes.handle('/run/alpha/cap', fakeRequest('POST', { tokenCap: 5 }), capResponse.response);
    const jid = ((await capResponse.result).body as { jid: string }).jid;

    await writes.handle(`/journal/${jid}/undo`, fakeRequest('POST'), fakeResponse().response);
    const secondResponse = fakeResponse();
    await writes.handle(`/journal/${jid}/undo`, fakeRequest('POST'), secondResponse.response);

    expect((await secondResponse.result).status).toBe(409);
  });
});

describe('ConsoleWrites.command / kill confirm flow', () => {
  it('answers a kill request with a confirm card, executing only after confirm <token>', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });

    const cards = await writes.command('kill alpha');
    const confirm = cards.find((card) => card.type === 'confirm');
    expect(confirm).toBeDefined();
    expect(actuator.killed).toEqual([]);

    const token = confirm!.btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;
    const afterConfirm = await writes.command(`confirm ${token}`);

    expect(actuator.killed).toEqual(['alpha']);
    expect(afterConfirm.some((card) => card.type === 'receipt')).toBe(true);
  });

  it("dismisses a pending kill by the confirm card's own Not now token, and never kills", async () => {
    registry.admit({ goal: 'bravo', cwd: dir, briefPath: join(dir, 'bravo.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'bravo' });

    const cards = await writes.command('kill bravo');
    const confirm = cards.find((card) => card.type === 'confirm')!;
    const dismissToken = confirm.btns!.find((btn) => btn.cmd.startsWith('dismiss '))!.cmd.split(' ')[1]!;

    const afterDismiss = await writes.command(`dismiss ${dismissToken}`);

    expect(actuator.killed).toEqual([]);
    expect(afterDismiss.some((card) => card.type === 'refusal')).toBe(false);
    // A confirm sent after the dismiss finds nothing pending -- the token was
    // consumed, not left around for a second click to act on.
    const afterConfirmToo = await writes.command(`confirm ${dismissToken}`);
    expect(afterConfirmToo.some((card) => card.type === 'refusal')).toBe(true);
    expect(actuator.killed).toEqual([]);
  });

  it('dismisses a pending merge-ready plan by its own Not now token, and merges nothing', async () => {
    registry.admit({ goal: 'charlie', cwd: dir, briefPath: join(dir, 'charlie.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'charlie' });
    appendOnce(journalPath, {
      event: 'run.gated', run: 'charlie', gate: { verdict: 'PASS', findings: [] } as never,
    });

    const cards = await writes.command('merge ready lanes');
    const plan = cards.find((card) => card.type === 'plan');
    if (!plan) {
      // No PASS-gated, launched, unmerged run in this fixture's chain state:
      // nothing to dismiss, so this scenario does not apply here.
      return;
    }
    const dismissToken = plan.btns!.find((btn) => btn.cmd.startsWith('dismiss '))!.cmd.split(' ')[1]!;
    await writes.command(`dismiss ${dismissToken}`);
    const afterRun = await writes.command(`run ${dismissToken}`);
    expect(afterRun.some((card) => card.type === 'refusal')).toBe(true);
  });

  it('refuses an unknown confirm token', async () => {
    const cards = await writes.command('confirm nope');
    expect(cards.some((card) => card.type === 'refusal')).toBe(true);
  });

  it('appends every operator message and card to the console thread', async () => {
    await writes.command('status');
    const threadLines = readFileSync(join(dir, 'console', 'thread.jsonl'), 'utf8').trim().split('\n');
    expect(threadLines.length).toBeGreaterThanOrEqual(2);
  });

  it('answers status, spend-today and what-stuck without throwing', async () => {
    appendOnce(journalPath, { event: 'note', actor: 'test' });
    await expect(writes.command('status')).resolves.toBeTruthy();
    await expect(writes.command('spend today')).resolves.toBeTruthy();
    await expect(writes.command("what's stuck")).resolves.toBeTruthy();
  });

  it('answers status from the lanes view when one is wired, not just a run count', async () => {
    const withView = new ConsoleWrites({
      journalPath, registry, inbox, actuator,
      authorized: () => true,
      ledgerPath: join(dir, 'actions-2.jsonl'),
      capsOverridesPath: join(dir, 'caps-2.json'),
      rulesConfigPath: join(dir, 'rules-2.json'),
      integrationsConfigPath: join(dir, 'integrations-2.json'),
      lanesView: () => ({
        at: Date.now(),
        lanes: [
          { id: 'alpha', ticket: 'BBZ-1', state: 'running' } as never,
          { id: 'beta', ticket: 'BBZ-2', state: 'running' } as never,
          { id: 'gamma', ticket: 'BBZ-3', state: 'blocked' } as never,
        ],
        tokensToday: 12.5, tokensPerMin: 0.75, links: { jiraSite: null, defaultRepo: null },
      }),
    });

    const cards = await withView.command('status');

    const reply = cards.find((card) => card.type === 'reply')!;
    expect(reply.text).toContain('2 running');
    expect(reply.text).toContain('1 blocked');
    expect(reply.text).toContain('Spent 13 tokens today');
    expect(reply.text).toContain('- BBZ-3 (blocked):');
    withView.stop();
  });

  it('lists at most five lanes needing attention, by id and state, labeling a runaway as such', async () => {
    const lanes = [
      { id: 'a', ticket: 'BBZ-11', state: 'parked' }, { id: 'b', ticket: 'BBZ-12', state: 'blocked' },
      { id: 'c', ticket: 'BBZ-13', state: 'running', runaway: true },
      { id: 'd', ticket: 'BBZ-14', state: 'parked' }, { id: 'e', ticket: 'BBZ-15', state: 'blocked' },
      { id: 'f', ticket: 'BBZ-16', state: 'parked' },
      { id: 'ok', ticket: 'BBZ-17', state: 'running' },
    ];
    const withView = new ConsoleWrites({
      journalPath, registry, inbox, actuator,
      authorized: () => true,
      ledgerPath: join(dir, 'actions-3.jsonl'),
      capsOverridesPath: join(dir, 'caps-3.json'),
      rulesConfigPath: join(dir, 'rules-3.json'),
      integrationsConfigPath: join(dir, 'integrations-3.json'),
      lanesView: () => ({
        at: Date.now(), lanes: lanes as never, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null },
      }),
    });

    const cards = await withView.command('status');

    const reply = cards.find((card) => card.type === 'reply')!;
    expect(reply.text).toContain('Needs you:');
    expect(reply.text).toContain('- BBZ-13 (runaway):');
    expect(reply.text).not.toContain('- BBZ-17 (');
    const namedLanes = reply.text.split('\n').filter((line) => line.startsWith('- '));
    expect(namedLanes).toHaveLength(5);
    withView.stop();
  });

  it('answers why-stuck with the lane state and reason first, then meaningful rows, skipping noise', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha', actor: 'runner' });
    appendOnce(journalPath, { event: 'burn.mismatch', run: 'alpha', actor: 'runner' });
    appendOnce(journalPath, { event: 'burn.mismatch', run: 'alpha', actor: 'runner' });
    appendOnce(journalPath, { event: 'burn.mismatch', run: 'alpha', actor: 'runner' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', actor: 'runner', reason: 'base drift' });

    const cards = await writes.command('why is alpha stuck');

    const reply = cards.find((card) => card.type === 'reply')!;
    // No lanesView wired here, so labelFor has nothing to name "alpha" by beyond the
    // id itself -- item 8's manual-lane fallback: an id shaped like none of ticket,
    // self, chain or probe reads as its own slug, the name a person typed.
    expect(reply.text.startsWith('alpha is blocked: base drift')).toBe(true);
    expect(reply.text).not.toContain('burn.mismatch');
  });

  it("answers 'spend today' with the same figure lanes.ts's tokensToday computes off the same journal", async () => {
    appendOnce(journalPath, {
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    const expected = tokensToday(replay(journalPath).runs, Date.now());

    const cards = await writes.command('spend today');

    const reply = cards.find((card) => card.type === 'reply')!;
    expect(reply.text).toBe(`spent ${fmtTokens(expected)} tokens today`);
  });

  it("answers an operator's free text against the one open ask", async () => {
    inbox.raise({ run: 'alpha', question: 'backfill or nullable?' });

    const cards = await writes.command('answer backfill');

    expect(cards.some((card) => card.type === 'receipt')).toBe(true);
    expect(inbox.open()).toHaveLength(0);
  });

  it('deliverable 3: answer <askKey> <text> delivers only the text, never the key alongside it', async () => {
    const raised = inbox.raise({ run: 'alpha', question: 'Restart the forge MCP connection?' });

    const cards = await writes.command(`answer ${raised.key} Restart`);

    const answered = inbox.entry(raised.key);
    expect(answered?.answer).toBe('Restart');
    const receipt = cards.find((card) => card.type === 'receipt')!;
    expect(receipt.text).toBe('Answered "Restart the forge MCP connection?": Restart');
  });

  it('W4: "answer <n>" resolves the option by number against the one open ask', async () => {
    inbox.raise({ run: 'alpha', question: 'NOT NULL or nullable?', options: ['NOT NULL', 'nullable + backfill'] });

    const cards = await writes.command('answer 2');

    expect(inbox.open()).toHaveLength(0);
    const receipt = cards.find((card) => card.type === 'receipt')!;
    expect(receipt.text).toBe('Answered "NOT NULL or nullable?": nullable + backfill');
  });

  it('W4: "answer <key> <n>" resolves the option by number against that key', async () => {
    const raised = inbox.raise({ run: 'alpha', question: 'NOT NULL or nullable?', options: ['NOT NULL', 'nullable + backfill'] });

    const cards = await writes.command(`answer ${raised.key} 1`);

    const answered = inbox.entry(raised.key);
    expect(answered?.answer).toBe('NOT NULL');
    const receipt = cards.find((card) => card.type === 'receipt')!;
    expect(receipt.text).toBe('Answered "NOT NULL or nullable?": NOT NULL');
  });

  it('W4: "answer <n>" refuses with the ambiguity reply when two asks are open', async () => {
    inbox.raise({ run: 'alpha', question: 'NOT NULL or nullable?', options: ['NOT NULL', 'nullable + backfill'] });
    inbox.raise({ run: 'beta', question: 'staging or dev?', options: ['staging', 'dev'] });

    const cards = await writes.command('answer 1');

    const refusal = cards.find((card) => card.type === 'refusal')!;
    expect(refusal).toBeDefined();
    expect(refusal.text).toContain('2 questions are open');
    expect(inbox.open()).toHaveLength(2);
  });

  it('W4: "answer <key> <n>" refuses when the key has no such option', async () => {
    const raised = inbox.raise({ run: 'alpha', question: 'NOT NULL or nullable?', options: ['NOT NULL', 'nullable + backfill'] });

    const cards = await writes.command(`answer ${raised.key} 5`);

    const refusal = cards.find((card) => card.type === 'refusal')!;
    expect(refusal).toBeDefined();
    expect(inbox.open()).toHaveLength(1);
  });
});

describe('ConsoleWrites: lane addressing by ticket key or title (deliverable 4)', () => {
  function writesWithLanes(lanes: unknown[]): ConsoleWrites {
    return new ConsoleWrites({
      journalPath, registry, inbox, actuator,
      authorized: () => true,
      ledgerPath: join(dir, `actions-${Math.random()}.jsonl`),
      capsOverridesPath: join(dir, `caps-${Math.random()}.json`),
      rulesConfigPath: join(dir, `rules-${Math.random()}.json`),
      integrationsConfigPath: join(dir, `integrations-${Math.random()}.json`),
      lanesView: () => ({ at: Date.now(), lanes: lanes as never, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } }),
    });
  }

  it('kill BBZ-182 resolves to the newest lane whose ticket matches, case-insensitively', async () => {
    registry.admit({ goal: 'queue-BBZ-182-2', cwd: dir, briefPath: join(dir, 'a.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'queue-BBZ-182-2', actor: 'runner' });
    const withLanes = writesWithLanes([
      { id: 'queue-BBZ-182-1', ticket: 'BBZ-182', startedAt: 1_000, state: 'blocked' },
      { id: 'queue-BBZ-182-2', ticket: 'bbz-182', startedAt: 5_000, state: 'blocked' },
    ]);

    const cards = await withLanes.command('kill BBZ-182');
    const confirm = cards.find((card) => card.type === 'confirm')!;
    const token = confirm.btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;
    await withLanes.command(`confirm ${token}`);
    expect(actuator.killed).toEqual(['queue-BBZ-182-2']);
    withLanes.stop();
  });

  it('resume BBZ-89 resolves and resumes only that lane, not every needs_aaron lane', async () => {
    registry.admit({ goal: 'queue-BBZ-89', cwd: dir, briefPath: join(dir, 'a.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'queue-BBZ-89', actor: 'runner' });
    appendOnce(journalPath, { event: 'run.paused', run: 'queue-BBZ-89', actor: 'runner' });
    const withLanes = writesWithLanes([
      { id: 'queue-BBZ-89', ticket: 'BBZ-89', startedAt: 1_000, state: 'paused' },
    ]);

    const cards = await withLanes.command('resume BBZ-89');
    expect(actuator.resumed).toEqual(['queue-BBZ-89']);
    expect(cards.some((card) => card.type === 'receipt')).toBe(true);
    withLanes.stop();
  });

  it('cap BBZ-96 at 500k resolves by ticket before setting the cap', async () => {
    registry.admit({ goal: 'queue-BBZ-96', cwd: dir, briefPath: join(dir, 'a.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'queue-BBZ-96', actor: 'runner' });
    const withLanes = writesWithLanes([
      { id: 'queue-BBZ-96', ticket: 'BBZ-96', startedAt: 1_000, state: 'running' },
    ]);

    const cards = await withLanes.command('cap BBZ-96 at 500k');
    expect(cards.some((card) => card.type === 'receipt')).toBe(true);
    expect(cards.some((card) => card.type === 'refusal')).toBe(false);
    withLanes.stop();
  });

  it('why is BBZ-226 stuck resolves by ticket', async () => {
    registry.admit({ goal: 'queue-BBZ-226', cwd: dir, briefPath: join(dir, 'a.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'queue-BBZ-226', actor: 'runner' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'queue-BBZ-226', actor: 'runner', reason: 'context ceiling' });
    const withLanes = writesWithLanes([
      { id: 'queue-BBZ-226', ticket: 'BBZ-226', startedAt: 1_000, state: 'blocked' },
    ]);

    const cards = await withLanes.command('why is BBZ-226 stuck');
    const reply = cards.find((card) => card.type === 'reply')!;
    expect(reply.text).toContain('context ceiling');
    withLanes.stop();
  });

  it('names what it looked for when nothing matches', async () => {
    const withLanes = writesWithLanes([{ id: 'queue-BBZ-1', ticket: 'BBZ-1', startedAt: 1_000, state: 'running' }]);

    const cards = await withLanes.command('kill BBZ-9999');
    const refusal = cards.find((card) => card.type === 'refusal')!;
    expect(refusal.text).toBe('No lane matches "BBZ-9999".');
    withLanes.stop();
  });

  it('falls back to a lane whose title contains the token when no ticket or id matches', async () => {
    registry.admit({ goal: 'queue-brief-tidy', cwd: dir, briefPath: join(dir, 'a.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'queue-brief-tidy', actor: 'runner' });
    const withLanes = writesWithLanes([
      { id: 'queue-brief-tidy', ticket: null, title: 'tidy the queue worker', startedAt: 1_000, state: 'running' },
    ]);

    const cards = await withLanes.command('kill worker');
    const confirm = cards.find((card) => card.type === 'confirm')!;
    const token = confirm.btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;
    await withLanes.command(`confirm ${token}`);
    expect(actuator.killed).toEqual(['queue-brief-tidy']);
    withLanes.stop();
  });
});

describe('ConsoleWrites: replies in words, multi-line (deliverable 5)', () => {
  function writesWithLanes(lanes: unknown[], tokensToday = 306_000_000, tokensPerMin = 2_400): ConsoleWrites {
    return new ConsoleWrites({
      journalPath, registry, inbox, actuator,
      authorized: () => true,
      ledgerPath: join(dir, `actions-${Math.random()}.jsonl`),
      capsOverridesPath: join(dir, `caps-${Math.random()}.json`),
      rulesConfigPath: join(dir, `rules-${Math.random()}.json`),
      integrationsConfigPath: join(dir, `integrations-${Math.random()}.json`),
      lanesView: () => ({ at: Date.now(), lanes: lanes as never, tokensToday, tokensPerMin, links: { jiraSite: null, defaultRepo: null } }),
    });
  }

  it('status: two summary lines, then Needs you with one line per attention lane', async () => {
    const withLanes = writesWithLanes([
      { id: 'a', ticket: 'BBZ-226', state: 'blocked', reason: 'checks are failure on head 88d44ec96baea849f7c1e8c0a1b2c3d4e5f6a7b8' },
      { id: 'b', state: 'running' },
    ]);
    const cards = await withLanes.command('status');
    const reply = cards.find((card) => card.type === 'reply')!;
    const lines = reply.text.split('\n');
    expect(lines[0]).toBe('2 lanes: 1 blocked, 1 running.');
    expect(lines[1]).toBe('Spent 306M tokens today, burning 2.4k tokens a minute.');
    expect(lines[2]).toBe('Needs you:');
    expect(lines[3]).toMatch(/^- BBZ-226 \(blocked\): checks are failure on head [0-9a-f]{7}$/);
    withLanes.stop();
  });

  it('what\'s stuck: nothing is stuck, or one line per signal using the shared phrasing', async () => {
    const noneStuck = writesWithLanes([]);
    const noneCards = await noneStuck.command("what's stuck");
    expect(noneCards.find((c) => c.type === 'reply')!.text).toBe('Nothing is stuck.');
    noneStuck.stop();

    const withStuck = new ConsoleWrites({
      journalPath, registry, inbox, actuator,
      authorized: () => true,
      ledgerPath: join(dir, `actions-${Math.random()}.jsonl`),
      capsOverridesPath: join(dir, `caps-${Math.random()}.json`),
      rulesConfigPath: join(dir, `rules-${Math.random()}.json`),
      integrationsConfigPath: join(dir, `integrations-${Math.random()}.json`),
      lanesView: () => ({ at: Date.now(), lanes: [{ id: 'alpha', ticket: 'BBZ-1', state: 'running' }] as never, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } }),
      stuck: () => [{ key: 'alpha', signal: 'context', threshold: 1, observed: 1, since: 1, hint: 'x' }],
    });
    const stuckCards = await withStuck.command("what's stuck");
    const reply = stuckCards.find((c) => c.type === 'reply')!;
    expect(reply.text).toBe('- BBZ-1: context ceiling reached, handed off to a fresh session');
    withStuck.stop();
  });

  it('merge ready lanes: plan items name the PR number and the ticket', async () => {
    registry.admit({ goal: 'queue-BBZ-99', cwd: dir, briefPath: join(dir, 'a.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'queue-BBZ-99', actor: 'runner' });
    appendOnce(journalPath, { event: 'chain.launched', actor: 'chain', packetId: 'p1', runKey: 'queue-BBZ-99' });
    appendOnce(journalPath, { event: 'chain.gated', actor: 'chain', packetId: 'p1', verdict: 'PASS' });
    const withLanes = writesWithLanes([
      { id: 'queue-BBZ-99', ticket: 'BBZ-99', state: 'done', pr: { no: 118, url: 'https://x/118', draft: false } },
    ]);
    const cards = await withLanes.command('merge ready lanes');
    const plan = cards.find((card) => card.type === 'plan')!;
    expect(plan.items!.map((item) => item.text)).toContain('Merge PR #118 (BBZ-99)');
    withLanes.stop();
  });

  it('kill: the confirm blast names the label, in words', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha', actor: 'runner' });
    const withLanes = writesWithLanes([{ id: 'alpha', ticket: 'BBZ-50', state: 'running' }]);
    const cards = await withLanes.command('kill alpha');
    const confirm = cards.find((card) => card.type === 'confirm')!;
    expect(confirm.blast).toBe('BBZ-50 stops now; its worktree and process are gone.');
    withLanes.stop();
  });

  it('unknown: the exact suggestion sentence', async () => {
    const cards = await writes.command('do a barrel roll');
    const reply = cards.find((card) => card.type === 'reply')!;
    expect(reply.text).toBe(
      'I did not understand that. Try one of: pause, resume, kill <ticket>, remove <ticket>, reopen <ticket>, '
      + "verify <ticket>, merge ready lanes, raise daily cap to <n>, cap <ticket> at <n>, why is <ticket> stuck, what's stuck, spend today, status, answer <text>.",
    );
  });
});

// W1 follow-up (2026-09-08): `parseIntent` learned remove/archive/retire, reopen and verify,
// but `executeIntent` had no case for any of them, so a typed "remove <lane>" still
// answered "I did not understand that" -- the exact reply from the mission. These prove
// each verb reaches its real function: retire through a confirm card into the retired
// log and the journal, reopen and verify straight into `run-actions.ts` (whose own
// refusal text is the proof the call was made).
describe('grammar verbs remove/archive/retire, reopen, verify actually execute', () => {
  function writesWithBoard(lanes: unknown[]): ConsoleWrites {
    return new ConsoleWrites({
      journalPath, registry, inbox, actuator,
      authorized: () => true,
      ledgerPath: join(dir, `actions-${Math.random()}.jsonl`),
      capsOverridesPath: join(dir, `caps-${Math.random()}.json`),
      rulesConfigPath: join(dir, `rules-${Math.random()}.json`),
      integrationsConfigPath: join(dir, `integrations-${Math.random()}.json`),
      forgeHomeDir: dir,
      lanesView: () => ({ at: Date.now(), lanes: lanes as never, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } }),
      lanesViewAll: () => ({ at: Date.now(), lanes: lanes as never, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } }),
    });
  }

  it('"remove <lane>" proposes a retire behind a confirm card and writes nothing until confirm', async () => {
    const withBoard = writesWithBoard([
      { id: '2026-09-04-acme-c2', ticket: null, title: 'a dead lane', state: 'unverified', heart: false, pr: null, kind: 'manual', startedAt: 1 },
    ]);
    const cards = await withBoard.command('remove 2026-09-04-acme-c2');
    const confirm = cards.find((card) => card.type === 'confirm');
    expect(confirm, `expected a confirm card, got ${JSON.stringify(cards.map((c) => [c.type, c.text]))}`).toBeDefined();
    expect(confirm!.blast).toMatch(/leaves the board/);
    expect(existsSync(retiredPath(dir))).toBe(false);
    expect(replay(journalPath).events.some((e) => e.event === 'lane.retired')).toBe(false);

    const token = confirm!.btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;
    const after = await withBoard.command(`confirm ${token}`);
    expect(after.find((card) => card.type === 'receipt')?.text).toMatch(/retired/);
    expect([...readRetired(retiredPath(dir)).keys()]).toEqual(['2026-09-04-acme-c2']);
    expect(replay(journalPath).events.some((e) => e.event === 'lane.retired' && e['run'] === '2026-09-04-acme-c2')).toBe(true);
    withBoard.stop();
  });

  it('"archive <lane>" on a lane with a live heart refuses at confirm time with the retire rule, and retires nothing', async () => {
    const withBoard = writesWithBoard([
      { id: 'live-1', ticket: 'ACME-7', title: 'still running', state: 'running', heart: true, pr: null, kind: 'queue', startedAt: 1 },
    ]);
    const cards = await withBoard.command('archive ACME-7');
    const confirm = cards.find((card) => card.type === 'confirm')!;
    const token = confirm.btns!.find((btn) => btn.cmd.startsWith('confirm '))!.cmd.split(' ')[1]!;
    const after = await withBoard.command(`confirm ${token}`);
    expect(after.find((card) => card.type === 'refusal')?.text).toMatch(/still open/);
    expect(existsSync(retiredPath(dir))).toBe(false);
    withBoard.stop();
  });

  it('"reopen <lane>" reaches reopenRun (its own state rule answers, not the grammar\'s "did not understand")', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha', actor: 'runner' });
    const cards = await writes.command('reopen alpha');
    const refusal = cards.find((card) => card.type === 'refusal');
    expect(refusal?.text).toMatch(/reopen needs killed\/blocked\/exhausted, not running/);
  });

  it('"verify <lane>" reaches verifyRun (its own "no chain packet" reason answers)', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha', actor: 'runner' });
    const cards = await writes.command('verify alpha');
    const refusal = cards.find((card) => card.type === 'refusal');
    expect(refusal?.text).toMatch(/no chain packet names a repo for run alpha/);
  });
});
