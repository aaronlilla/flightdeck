import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Actuator, DecisionId, RunId } from '../../../src/forge/contracts.js';
import { appendOnce, replay } from '../../../src/forge/journal.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Registry } from '../../../src/forge/registry.js';
import { ConsoleWrites, parseIntent } from '../../../src/forge/console/command.js';
import { spentTodayUsd } from '../../../src/forge/console/lanes.js';

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
    expect(parseIntent('raise daily cap to $50')).toEqual({ kind: 'set-daily-cap', amount: 50 });
    expect(parseIntent('set daily cap to 50')).toEqual({ kind: 'set-daily-cap', amount: 50 });
    expect(parseIntent('cap FLT-204 at $5')).toEqual({ kind: 'set-run-cap', lane: 'FLT-204', amount: 5 });
    expect(parseIntent("why is lane FLT-1 stuck")).toEqual({ kind: 'why-stuck', lane: 'FLT-1' });
    expect(parseIntent("what's stuck")).toEqual({ kind: 'what-stuck' });
    expect(parseIntent('spend today')).toEqual({ kind: 'spend-today' });
    expect(parseIntent('status')).toEqual({ kind: 'status' });
    expect(parseIntent('answer backfill')).toEqual({ kind: 'answer', text: 'backfill' });
    expect(parseIntent('confirm abc123')).toEqual({ kind: 'confirm', token: 'abc123' });
    expect(parseIntent('run abc123')).toEqual({ kind: 'run-plan', token: 'abc123' });
    expect(parseIntent('gibberish')).toEqual({ kind: 'unknown', text: 'gibberish' });
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
    const outcome = await result;
    expect(outcome.status).toBe(200);
    expect(actuator.killed).toEqual(['alpha']);
  });

  it('refuses a run cap above the hard limit with 422', async () => {
    const { response, result } = fakeResponse();

    await writes.handle('/run/alpha/cap', fakeRequest('POST', { capUsd: 999999 }), response);

    const outcome = await result;
    expect(outcome.status).toBe(422);
  });

  it('undoes a pause through POST /journal/:jid/undo', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    const pauseResponse = fakeResponse();
    await writes.handle('/run/alpha/pause', fakeRequest('POST', { reason: 'op' }), pauseResponse.response);
    const paused = await pauseResponse.result;
    const jid = (paused.body as { jid: string }).jid;

    const undoResponse = fakeResponse();
    const handled = await writes.handle(`/journal/${jid}/undo`, fakeRequest('POST'), undoResponse.response);
    const undone = await undoResponse.result;

    expect(handled).toBe(true);
    expect(undone.status).toBe(200);
    expect(actuator.resumed).toEqual(['alpha']);
  });

  it('refuses a second undo of the same jid with 409', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    const pauseResponse = fakeResponse();
    await writes.handle('/run/alpha/pause', fakeRequest('POST', { reason: 'op' }), pauseResponse.response);
    const jid = ((await pauseResponse.result).body as { jid: string }).jid;

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
          { id: 'alpha', state: 'running' } as never, { id: 'beta', state: 'running' } as never,
          { id: 'gamma', state: 'blocked' } as never,
        ],
        spentTodayUsd: 12.5, burnUsdPerMin: 0.75,
      }),
    });

    const cards = await withView.command('status');

    const reply = cards.find((card) => card.type === 'reply')!;
    expect(reply.text).toContain('2 running');
    expect(reply.text).toContain('1 blocked');
    expect(reply.text).toContain('$12.50');
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
    expect(reply.text.startsWith('blocked: base drift')).toBe(true);
    expect(reply.text).not.toContain('burn.mismatch');
  });

  it("answers 'spend today' with the same figure lanes.ts's spentTodayUsd computes off the same journal", async () => {
    appendOnce(journalPath, {
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    const expected = spentTodayUsd(replay(journalPath).runs, Date.now());

    const cards = await writes.command('spend today');

    const reply = cards.find((card) => card.type === 'reply')!;
    expect(reply.text).toBe(`spent $${expected.toFixed(2)} today`);
  });

  it("answers an operator's free text against the one open ask", async () => {
    inbox.raise({ run: 'alpha', question: 'backfill or nullable?' });

    const cards = await writes.command('answer backfill');

    expect(cards.some((card) => card.type === 'receipt')).toBe(true);
    expect(inbox.open()).toHaveLength(0);
  });
});
