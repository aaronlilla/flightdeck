/**
 * `RoundsRoutes`: the sheet and apply behind `GET /rounds` and `POST /rounds/apply`,
 * and the ticker's two modes. With `apply` off a tick journals one `rounds.sheet` row
 * and one rail card per change of findings, and never touches the store. With `apply`
 * on it acts through the store, and hands the asks it cannot settle to the Conductor
 * once per ask key.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import { judgeMessage, RoundsRoutes } from '../../../src/forge/console/rounds-route.js';
import type { Blocker, Lane, Message } from '../../../src/shared/console-model.js';

const NOW = 20_000_000;
const MIN = 60_000;

function lane(overrides: Partial<Lane> & { id: string }): Lane {
  return {
    ticket: null, model: 'sonnet-5', modelId: null, className: null, repo: null, attempt: 1,
    state: 'running', reason: null, stepN: 0, stepTotal: 0, stepText: '', ctxTokens: 0, ctxCeiling: 0,
    ctxCompactAt: 0, tokens: 0, tokenCap: null, tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live',
    observedAt: NOW - MIN, verifiedAt: null, heart: false, since: NOW - 60 * MIN, startedAt: NOW - 60 * MIN,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    title: null, kind: 'manual', sourceUrl: null, plain: '', now: '', did: null, you: null, mergeable: null,
    attempts: 1, retiredAt: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: NOW },
    ...overrides,
  } as Lane;
}

let dir: string;
let store: QueueStore;
let journalPath: string;
let policyPath: string;
let thread: Message[];
let asked: string[];

function policy(rounds: Record<string, unknown>): void {
  writeFileSync(policyPath, JSON.stringify({ conductor: { rounds } }));
}

function journalEvents(): Array<Record<string, unknown>> {
  try {
    return readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function routes(lanes: Lane[], blockers: Blocker[] = []): RoundsRoutes {
  return new RoundsRoutes({
    store, lanesAll: () => lanes, blockers: async () => blockers,
    retireDeps: () => ({ forgeHomeDir: dir, journalPath, lanesAll: () => lanes }),
    journalPath, authorized: () => true, publish: () => undefined,
    appendThread: (m) => { thread.push(m); },
    askConductor: async (text) => { asked.push(text); },
    policyPath, now: () => NOW,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rounds-route-'));
  store = new QueueStore(join(dir, 'queue.jsonl'));
  journalPath = join(dir, 'journal.jsonl');
  policyPath = join(dir, 'policy.json');
  thread = [];
  asked = [];
  policy({});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const parkedRow = { id: 'q1', at: 1, source: 'ticket', input: 'ACME-1', ticket: 'ACME-1', state: 'parked', reason: 'parked', createdAt: 1, updatedAt: 1 } as const;
const deadRow = { id: 'q2', at: 1, source: 'ticket', input: 'ACME-2', ticket: 'ACME-2', state: 'running', runKey: 'run-2', createdAt: 1, updatedAt: 1 } as const;
const deadLane = lane({ id: 'run-2', state: 'blocked', reason: 'its process is gone and it never reported finishing' });
const askLane = lane({ id: 'run-3', state: 'parked', question: { key: 'k3', text: 'ACME-3 is already merged as PR #9, zero diff. Stop?', opts: [], askedAt: NOW - 5 * MIN } });

describe('RoundsRoutes.sheet', () => {
  it('reads the store, the lanes and the blockers, with the policy\'s own numbers', async () => {
    policy({ silentMinutes: 5, orphanHours: 1, maxRelaunches: 3 });
    store.append(parkedRow as never);
    const sheet = await routes([deadLane]).sheet();
    expect(sheet.params).toEqual({ silentAfterMs: 5 * MIN, orphanAfterMs: 60 * MIN, maxRelaunches: 3 });
    expect(sheet.findings.map((f) => [f.itemId, f.action])).toEqual([['q1', 'retry']]);
  });

  it('counts prior rounds relaunches off the item\'s own history so the cap holds across ticks', async () => {
    policy({ maxRelaunches: 1 });
    store.append(deadRow as never);
    store.append({ id: 'q2', at: 2, state: 'parked', reason: 'rounds: dead', updatedAt: 2 });
    store.append({ id: 'q2', at: 3, state: 'running', reason: null, retriedAt: 3, updatedAt: 3 });
    const sheet = await routes([deadLane]).sheet();
    expect(sheet.findings[0]).toMatchObject({ itemId: 'q2', kind: 'dead-worker', action: 'judge' });
    expect(sheet.findings[0]!.why).toContain('relaunched it 1 time');
  });
});

describe('RoundsRoutes.tick with apply off', () => {
  it('journals the sheet and posts one rail card, changes nothing, and stays quiet while the findings are the same', async () => {
    store.append(parkedRow as never);
    const r = routes([]);
    await r.tick();
    expect(store.get('q1')!.state).toBe('parked');
    expect(journalEvents().filter((e) => e['event'] === 'rounds.sheet')).toHaveLength(1);
    expect(journalEvents()[0]).toMatchObject({ mode: 'dry-run', findings: 1, kinds: { unblocked: 1 } });
    expect(thread).toHaveLength(1);
    expect(thread[0]!.text).toMatch(/^Rounds \(dry run\): 1 finding\(s\): 1 unblocked/);
    await r.tick();
    expect(journalEvents()).toHaveLength(1);
    expect(thread).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('does nothing at all when rounds are disabled', async () => {
    policy({ enabled: false });
    store.append(parkedRow as never);
    await routes([]).tick();
    expect(journalEvents()).toEqual([]);
    expect(thread).toEqual([]);
  });
});

describe('RoundsRoutes.tick with apply on', () => {
  it('acts through the store, posts a receipt per action, and hands each new ask to the Conductor once', async () => {
    policy({ apply: true });
    store.append(parkedRow as never);
    store.append(deadRow as never);
    const r = routes([deadLane, askLane]);
    await r.tick();
    expect(store.get('q1')!.state).toBe('queued');
    expect(store.get('q2')).toMatchObject({ state: 'running', retriedAt: NOW });
    expect(thread.map((m) => m.text)).toEqual([
      expect.stringMatching(/^Restarted ACME-1/),
      expect.stringMatching(/^Relaunched ACME-2/),
    ]);
    expect(journalEvents().filter((e) => e['event'] === 'rounds.applied')).toHaveLength(2);
    expect(journalEvents().find((e) => e['event'] === 'rounds.sheet')).toMatchObject({ mode: 'applied', applied: 2 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('askKey=k3');
    expect(asked[0]).toContain('suggested answer:');
    await r.tick();
    expect(asked).toHaveLength(1);
  });
});

describe('RoundsRoutes.handle', () => {
  function fakeHttp(method: string) {
    let status = 0;
    let body = '';
    const request = { method } as never;
    const response = {
      writeHead: (s: number) => { status = s; },
      end: (b: string) => { body = b; },
    } as never;
    return { request, response, read: () => ({ status, body: JSON.parse(body) as Record<string, unknown> }) };
  }

  it('GET /rounds answers the sheet, its lines and the policy without acting', async () => {
    store.append(parkedRow as never);
    const http = fakeHttp('GET');
    expect(await routes([]).handle('/rounds', http.request, http.response)).toBe(true);
    const { status, body } = http.read();
    expect(status).toBe(200);
    expect((body['lines'] as string[])[0]).toMatch(/^Rounds \(dry run, nothing changed\)/);
    expect(body['policy']).toMatchObject({ apply: false });
    expect(store.get('q1')!.state).toBe('parked');
  });

  it('POST /rounds/apply acts and reports what it applied', async () => {
    store.append(parkedRow as never);
    const http = fakeHttp('POST');
    expect(await routes([]).handle('/rounds/apply', http.request, http.response)).toBe(true);
    expect(http.read().body).toMatchObject({ ok: true, applied: 1 });
    expect(store.get('q1')!.state).toBe('queued');
  });

  it('leaves other paths alone', async () => {
    const http = fakeHttp('GET');
    expect(await routes([]).handle('/queue', http.request, http.response)).toBe(false);
  });
});

describe('judgeMessage', () => {
  it('names each ask with its key, the question and the suggested answer, and forbids kills', () => {
    const text = judgeMessage([{
      kind: 'ask', action: 'judge', itemId: null, laneId: 'run-3', label: 'ACME-3', why: 'w',
      ask: { key: 'k3', text: 'done?', looksDone: true, suggested: 'Stop.' },
    }]);
    expect(text).toContain('ACME-3 askKey=k3 lane=run-3: w');
    expect(text).toContain('question: done?');
    expect(text).toContain('suggested answer: Stop.');
    expect(text).toContain('Never kill or remove anything from here.');
  });
});
