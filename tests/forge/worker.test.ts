/**
 * The worker loop, driven by a fake engine stream. No model is called here.
 *
 * Four behaviours decide whether the Spine is worth building, and each has a row below.
 *
 *   the ceiling      at the class's maxContext the worker asks for a handoff instead of
 *                    growing. Context is charged again on every turn, so a session that
 *                    only accumulates is the whole 2026-09-03 bill in one sentence.
 *   the successor    it starts on the same model, seeded with the handoff packet. A
 *                    successor that changed tier would smuggle escalation back in through
 *                    the one door the policy file does not watch.
 *   no tier on retry a bounce, a failure and a resume all leave the model alone.
 *   the environment  nine inherited CLAUDE names are stripped before spawn, or the child
 *                    saves no transcript and nothing can classify it. ANTHROPIC_API_KEY
 *                    goes too, so the subscription login is what authenticates.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { INHERITED, Worker, workerEnv, type FakeTurn } from '../../src/forge/worker.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { Inbox } from '../../src/forge/inbox.js';
import { readParkRecord, writeParkRecord } from '../../src/forge/parkrecord.js';
import { Registry } from '../../src/forge/registry.js';
import {
  clearKillSwitch, engageKillSwitch, Fleet, Lanes, readKillSwitch,
} from '../../src/forge/supervisor.js';

let dir: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-worker-'));
  journalPath = join(dir, 'fleet.jsonl');
  // I13: `Worker.run()` now clears a run's park record (`parkrecord.ts`, under
  // `runDir()`) at every terminal transition. `runDir()` resolves through `forgeHome()`,
  // which falls back to this machine's real `~/.forge` when unset -- pinned here so that
  // clear (a real filesystem call) never reaches outside this test's own temp directory.
  process.env['FORGE_HOME'] = dir;
});

/** A stream of turns whose context climbs by `step` each turn. */
function climbing(step: number, turns: number, from = 0): FakeTurn[] {
  return Array.from({ length: turns }, (_unused, index) => ({
    text: `turn ${index}`,
    context: from + step * (index + 1),
  }));
}

type FakeEngine = ReturnType<typeof fakeEngine>;

function makeWorker(script: FakeTurn[][], overrides: Record<string, unknown> = {}) {
  const engine = fakeEngine(script);
  const worker = new Worker({
    run: 'alpha',
    brief: '# Goal\n\nDo the thing.\n',
    briefPath: join(dir, 'brief.md'),
    cwd: dir,
    journalPath,
    engine,
    ...overrides,
  } as never);
  // The concrete fake, not the interface: the specimens assert on what it recorded,
  // and EngineLike deliberately does not expose that.
  return worker as unknown as {
    run: () => Promise<{ handoffs: number; verdict: string }>;
    engine: FakeEngine;
  };
}

/**
 * Hands the worker one scripted session per start, in order.
 *
 * `send` is a prompt into a session that is already open, which is how the real SDK
 * takes the handoff request: it does not start a session, so it does not consume a
 * script slot. Modelling it as another start would have made every ceiling look like
 * two sessions and hidden a doubled spawn behind a green suite.
 */
function fakeEngine(script: FakeTurn[][]) {
  let index = 0;
  return {
    started: [] as { model: string; prompt: string; env: NodeJS.ProcessEnv }[],
    sent: [] as { sessionId: string; prompt: string }[],
    async run(config: { model: string; prompt: string; env: NodeJS.ProcessEnv }) {
      const turns = script[index] ?? [];
      index += 1;
      const sessionId = `session-${index}`;
      this.started.push(config);
      const engine = this;
      return {
        sessionId,
        turns,
        async send(prompt: string) {
          engine.sent.push({ sessionId, prompt });
          return [{ text: `packet for ${sessionId}`, context: 0 }];
        },
      };
    },
  };
}

describe('the context ceiling', () => {
  it('asks for a handoff once a session reaches its class maxContext', async () => {
    const worker = makeWorker([climbing(30_000, 8)], { maxContext: 60_000 });
    const result = await worker.run();

    expect(result.handoffs).toBeGreaterThanOrEqual(1);
    const state = replay(journalPath);
    expect(state.handoffs).toBeGreaterThanOrEqual(1);
    expect(state.events.some((e) => e.event === 'run.handoff')).toBe(true);
  });

  it('leaves a session that stays under the ceiling alone', async () => {
    const worker = makeWorker([climbing(1_000, 5)], { maxContext: 60_000 });
    const result = await worker.run();

    expect(result.handoffs).toBe(0);
    expect(replay(journalPath).handoffs).toBe(0);
  });

  it('injects the handoff prompt rather than killing the session outright', async () => {
    const worker = makeWorker([climbing(30_000, 4), []], { maxContext: 60_000 });
    await worker.run();
    const state = replay(journalPath);
    const handoff = state.events.find((e) => e.event === 'run.handoff');
    expect(handoff?.['reason']).toMatch(/context/i);
    // Into the session that holds the context, not a fresh one: the packet is the one
    // thing that needs the conversation about to be thrown away.
    expect(worker.engine.sent[0]?.sessionId).toBe('session-1');
    expect(worker.engine.sent[0]?.prompt).toMatch(/CONTEXT CEILING REACHED/);
  });
});

describe('I13: a park record does not outlive its run', () => {
  it('is gone once the run hands off to a successor', async () => {
    writeParkRecord('alpha', { key: 'warden:alpha', reason: 'idle for 300s', at: Date.now() });
    const worker = makeWorker([climbing(30_000, 8)], { maxContext: 60_000 });

    await worker.run();

    expect(readParkRecord('alpha')).toBeUndefined();
  });

  it('is gone once the run finishes, whatever the verdict', async () => {
    writeParkRecord('alpha', { key: 'warden:alpha', reason: 'idle for 300s', at: Date.now() });
    const worker = makeWorker([climbing(1_000, 5)], { maxContext: 60_000 });

    const result = await worker.run();

    expect(['stopped', 'exhausted', 'parked']).toContain(result.verdict);
    expect(readParkRecord('alpha')).toBeUndefined();
  });

  it('is gone once a mid-loop park is answered and the run resumes', async () => {
    writeParkRecord('alpha', { key: 'warden:alpha', reason: 'idle for 300s', at: Date.now() });
    const inboxDir = join(dir, 'inbox');
    const inbox = new Inbox(inboxDir);
    let key: string | undefined;

    const engine = {
      started: [] as unknown[],
      inbox,
      async run(config: { run: string }) {
        this.started.push(config);
        const entry = inbox.raise({
          run: config.run, goal: config.run, actionTarget: 'AskUserQuestion',
          question: 'dev or prod?', options: ['dev', 'prod'], kind: 'question',
        });
        key = entry.key;
        return {
          sessionId: 'session-1', turns: [],
          async send() { return [{ text: 'shipped', context: 10, done: true }]; },
        };
      },
      parkedOn(run: string) { return run === 'alpha' ? key : undefined; },
      clearPark() { key = undefined; },
    };

    const brief = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    const exec = async (request: { argv: string[] }) => ({
      ok: true, tail: '', returncode: 0, argv: request.argv, owner: 'alpha', startedAt: 0, durationMs: 1,
    });
    const worker = new Worker({
      run: 'alpha', brief, briefPath: join(dir, 'brief.md'), cwd: dir, journalPath,
      engine: engine as never, exec, pollIntervalMs: 10,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    setTimeout(() => {
      const outside = new Inbox(inboxDir);
      const waiting = outside.open()[0];
      if (waiting) outside.answer(waiting.key, 'go with dev');
    }, 15);

    await worker.run();

    expect(readParkRecord('alpha')).toBeUndefined();
  });
});

describe('the successor', () => {
  it('starts on the same model as the session it replaces', async () => {
    const worker = makeWorker([climbing(30_000, 4), climbing(1_000, 2)], {
      maxContext: 60_000,
    });
    await worker.run();
    const models = worker.engine.started.map((entry) => entry.model);
    expect(models).toHaveLength(2);
    expect(models[1]).toBe(models[0]);
  });

  it('seeds the successor with the handoff packet', async () => {
    const worker = makeWorker([climbing(30_000, 4), climbing(1_000, 2)], {
      maxContext: 60_000,
    });
    await worker.run();
    expect(worker.engine.started[1]?.prompt).toMatch(/handoff/i);
  });

  it('names the successor in the journal and points it back at its predecessor', async () => {
    const worker = makeWorker([climbing(30_000, 4), climbing(1_000, 2)], {
      maxContext: 60_000,
    });
    await worker.run();
    const state = replay(journalPath);
    const first = state.runs['alpha'];
    expect(first?.successor).toBeTruthy();
    expect(state.runs[first!.successor!]?.predecessor).toBe('alpha');
  });
});

describe('the tier', () => {
  it('runs an ordinary brief on the implement model', async () => {
    const worker = makeWorker([climbing(1_000, 2)]);
    await worker.run();
    expect(worker.engine.started[0]?.model).toBe('claude-sonnet-5');
  });

  it('runs a brief carrying tier: opus on implement-hard', async () => {
    const worker = makeWorker([climbing(1_000, 2)], {
      brief: '# Goal\n\ntier: opus\n\nDo the hard thing.\n',
    });
    await worker.run();
    expect(worker.engine.started[0]?.model).toBe('claude-opus-5');
  });

  it('does not change tier across a retry, however many there have been', async () => {
    const worker = makeWorker(
      [climbing(1_000, 2), climbing(1_000, 2), climbing(1_000, 2)],
      { attempt: 9, fixRound: 4, resumes: 12 },
    );
    await worker.run();
    expect(worker.engine.started[0]?.model).toBe('claude-sonnet-5');
  });

  it('does not change tier across a handoff either', async () => {
    const worker = makeWorker([climbing(30_000, 4), climbing(30_000, 4), climbing(1_000, 1)], {
      maxContext: 60_000,
    });
    await worker.run();
    const models = new Set(worker.engine.started.map((entry) => entry.model));
    expect(models.size).toBe(1);
    expect([...models][0]).toBe('claude-sonnet-5');
  });
});

describe('the environment a worker is spawned with', () => {
  it('strips all nine inherited CLAUDE names', () => {
    const dirty: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const name of INHERITED) dirty[name] = 'inherited';
    const clean = workerEnv(dirty);

    expect(INHERITED).toHaveLength(9);
    for (const name of INHERITED) expect(clean[name]).toBeUndefined();
    expect(clean['PATH']).toBe('/usr/bin');
  });

  it('unsets ANTHROPIC_API_KEY so the subscription login is what authenticates', () => {
    const clean = workerEnv({ ANTHROPIC_API_KEY: 'sk-should-not-travel', PATH: '/usr/bin' });
    expect(clean['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('leaves everything else the parent had', () => {
    const home = join(tmpdir(), 'forge-home-specimen');
    const clean = workerEnv({ HOME: home, FOO: 'bar' });
    expect(clean['HOME']).toBe(home);
    expect(clean['FOO']).toBe('bar');
  });

  it('is what the worker actually spawns with', async () => {
    const worker = makeWorker([climbing(1_000, 1)], {
      parentEnv: { CLAUDECODE: '1', CLAUDE_PID: '42', PATH: '/usr/bin' },
    });
    await worker.run();
    const spawned = worker.engine.started[0]?.env ?? {};
    expect(spawned['CLAUDECODE']).toBeUndefined();
    expect(spawned['CLAUDE_PID']).toBeUndefined();
    expect(spawned['PATH']).toBe('/usr/bin');
  });
});

describe('B.3.4: done is verified', () => {
  it('yields unverified, never done, when the brief has no Verification block', async () => {
    const worker = makeWorker([[{ text: 'shipped', context: 10, done: true }]]);
    const result = await worker.run();

    expect(result.verdict).toBe('unverified');
    const finished = replay(journalPath).events
      .find((e) => e.event === 'run.finished' && e.run === 'alpha');
    expect(finished?.['verdict']).toBe('unverified');
  });

  it('runs the declared verification command and only marks done once it passes', async () => {
    const brief = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    const calls: string[] = [];
    const exec = async (request: { argv: string[] }) => {
      calls.push(request.argv.join(' '));
      return {
        ok: true, tail: '', returncode: 0, argv: request.argv, owner: 'alpha',
        startedAt: 0, durationMs: 1,
      };
    };
    const worker = makeWorker([[{ text: 'shipped', context: 10, done: true }]], { brief, exec });

    const result = await worker.run();

    expect(result.verdict).toBe('done');
    expect(calls).toEqual(['node -e process.exit(0)']);
  });

  it('bounces a failing verification command three times, then parks', async () => {
    const brief = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnpm run verify\n```\n';
    let execCalls = 0;
    const exec = async (request: { argv: string[] }) => {
      execCalls += 1;
      return {
        ok: false, tail: 'FAIL', returncode: 1, argv: request.argv, owner: 'alpha',
        startedAt: 0, durationMs: 1,
      };
    };
    const worker = makeWorker([[{ text: 'shipped', context: 10, done: true }]], { brief, exec });

    const result = await worker.run();

    expect(result.verdict).toBe('parked');
    expect(execCalls).toBe(3);
    const bounces = replay(journalPath).events.filter((e) => e.event === 'run.verify-failed');
    expect(bounces).toHaveLength(3);
  });

  it('journals the usage from a bounce reply, so a verification retry is not free', async () => {
    const brief = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnpm run verify\n```\n';
    let execCalls = 0;
    const exec = async (request: { argv: string[] }) => {
      execCalls += 1;
      return {
        ok: execCalls > 1, tail: execCalls > 1 ? '' : 'FAIL', returncode: execCalls > 1 ? 0 : 1,
        argv: request.argv, owner: 'alpha', startedAt: 0, durationMs: 1,
      };
    };
    const bounceUsage = { input: 500, cacheRead: 0, cacheCreation: 0, output: 20 };
    const engine = {
      async run() {
        return {
          sessionId: 'session-bounce',
          turns: [{ text: 'shipped', context: 10, done: true }],
          async send() {
            return [{ text: 'retrying', context: 15, usage: bounceUsage }];
          },
        };
      },
    };
    const worker = new Worker({
      run: 'alpha', brief, briefPath: join(dir, 'brief.md'), cwd: dir, journalPath,
      engine, exec,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    const result = await worker.run();

    expect(result.verdict).toBe('done');
    const turnEnds = replay(journalPath).events.filter((e) => e.event === 'turn.end');
    expect(turnEnds.some((e) => JSON.stringify(e['usage']) === JSON.stringify(bounceUsage))).toBe(true);
  });

  it('the falsifier: done is never reachable without exec having actually run', async () => {
    const brief = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    const order: string[] = [];
    const exec = async (request: { argv: string[] }) => {
      order.push('exec');
      return {
        ok: true, tail: '', returncode: 0, argv: request.argv, owner: 'alpha',
        startedAt: 0, durationMs: 1,
      };
    };
    const worker = makeWorker([[{ text: 'shipped', context: 10, done: true }]], { brief, exec });

    const result = await worker.run();

    expect(result.verdict).toBe('done');
    expect(order).toEqual(['exec']);
  });
});

describe('B.3.6: honest recording', () => {
  it('sentence 6: a throw from engine.run becomes run.paused with the verbatim error, not an uncaught rejection', async () => {
    const throwingEngine = {
      started: [] as unknown[],
      async run(): Promise<never> {
        throw new Error('the SDK subprocess exited with code 1');
      },
    };
    const worker = new Worker({
      run: 'throwing-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: throwingEngine as never,
    });

    const result = await worker.run();

    expect(result.verdict).not.toBe('done');
    const state = replay(journalPath);
    const paused = state.events.find((e) => e.event === 'run.paused' && e.run === 'throwing-run');
    expect(paused?.['reason']).toBe('the SDK subprocess exited with code 1');
  });

  it('sentence 7: no phantom handoff on the last permitted session', async () => {
    // maxSessions: 1 -- this session's own ceiling hit has nowhere to hand off to.
    const worker = makeWorker([climbing(30_000, 4)], { maxContext: 60_000, maxSessions: 1 });
    const result = await worker.run();

    expect(result.handoffs).toBe(0);
    expect(worker.engine.started).toHaveLength(1);
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.handoff')).toBe(false);
  });

  it('sentence 8: the handoff reply\'s own usage is journaled, not discarded once its text is read', async () => {
    let sendCalls = 0;
    const engine = {
      started: [] as { model: string; prompt: string; env: NodeJS.ProcessEnv }[],
      async run(config: { model: string; prompt: string; env: NodeJS.ProcessEnv }) {
        this.started.push(config);
        return {
          sessionId: 'session-1',
          turns: climbing(30_000, 4),
          async send(_prompt: string) {
            sendCalls += 1;
            return [{
              text: 'packet', context: 5_000,
              usage: { input: 5_000, cacheRead: 0, cacheCreation: 0, output: 20 },
            }];
          },
        };
      },
    };
    const worker = new Worker({
      run: 'handoff-usage-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: engine as never, maxContext: 60_000, maxSessions: 2,
    });
    await worker.run();

    expect(sendCalls).toBe(1);
    const state = replay(journalPath);
    const handoffTurn = state.events.find((e) => e.event === 'turn.end' && e.run === 'handoff-usage-run'
      && (e['usage'] as { input: number } | undefined)?.input === 5_000);
    expect(handoffTurn).toBeDefined();
  });
});

describe('B.3.8: no caps on implementation', () => {
  it('carries no maxTurns for an implement-class run', async () => {
    // The default brief (no `tier:` line) resolves to the implement class.
    const worker = makeWorker([[{ text: 'ok', context: 10 }]]);
    await worker.run();
    expect(worker.engine.started[0]).not.toHaveProperty('maxTurns');
  });

  it('the falsifier: a large number is not an omission', async () => {
    const worker = makeWorker([[{ text: 'ok', context: 10 }]]);
    await worker.run();
    const started = worker.engine.started[0] as { maxTurns?: number };
    expect(started.maxTurns).not.toBe(Number.MAX_SAFE_INTEGER);
    expect(started.maxTurns).toBeUndefined();
  });

  it('three sessions with no commit park the run with a report naming the three', async () => {
    // Each session hits the ceiling, so the chain would otherwise hand off forever with
    // no session cap (B.3.8 removes it for implement classes): the stuck rule is what
    // has to stop it instead.
    const worker = makeWorker([
      climbing(30_000, 4), climbing(30_000, 4), climbing(30_000, 4), climbing(30_000, 4),
    ], { maxContext: 60_000 });

    const result = await worker.run();

    expect(result.verdict).toBe('parked');
    // Exactly three sessions ran, not a fourth: the stuck rule fired the moment the third
    // one closed without a commit, before any successor could start.
    expect(worker.engine.started).toHaveLength(3);
    const state = replay(journalPath);
    const parked = state.events.find((e) => e.event === 'run.finished' && e['verdict'] === 'parked');
    expect(parked?.['report']).toBe('three sessions without a commit: alpha, alpha-2, alpha-3');
  });

  it('a session that commits resets the count, so the chain is not stuck', async () => {
    let index = 0;
    const engine = {
      started: [] as { model: string; prompt: string; env: NodeJS.ProcessEnv }[],
      async run(config: { model: string; prompt: string; env: NodeJS.ProcessEnv }) {
        index += 1;
        this.started.push(config);
        return {
          sessionId: `session-${index}`,
          turns: climbing(30_000, 4),
          committed: index === 2,
          async send(_prompt: string) {
            return [{ text: 'packet', context: 0 }];
          },
        };
      },
    };
    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: engine as never, maxContext: 60_000,
      // Bounded so the specimen terminates: climbing() never sets done, and with no
      // session cap (the very thing B.3.8 removes) an always-committed-false chain would
      // otherwise run forever. Session 2 commits, which is the thing under test.
      maxSessions: 4,
    });

    const result = await worker.run();

    // Session 2 committed, resetting the count to zero; sessions 3 and 4 bring it back to
    // two, still under three by the time the chain runs out of its own bounded budget --
    // it stops for running out of sessions, not because the stuck rule fired.
    expect(result.verdict).not.toBe('parked');
    expect(engine.started).toHaveLength(4);
  });
});

describe('F1: a segment that ends while parked keeps waiting, not stopped', () => {
  it('resumes the same session once a second Inbox instance writes the answer, and ends done', async () => {
    const inboxDir = join(dir, 'inbox');
    const inbox = new Inbox(inboxDir);
    let key: string | undefined;
    let resumedPrompt: string | undefined;

    // The model asked, `canUseTool` denied it, and the segment ended with zero turns: the
    // exact shape a real park leaves for worker.ts to find, with no live SDK involved.
    const engine = {
      started: [] as unknown[],
      inbox,
      async run(config: { run: string }) {
        this.started.push(config);
        const entry = inbox.raise({
          run: config.run, goal: config.run, actionTarget: 'AskUserQuestion',
          question: 'dev or prod?', options: ['dev', 'prod'], kind: 'question',
        });
        key = entry.key;
        return {
          sessionId: 'session-1',
          turns: [],
          async send(prompt: string) {
            resumedPrompt = prompt;
            return [{ text: 'shipped', context: 10, done: true }];
          },
        };
      },
      parkedOn(run: string) {
        return run === 'alpha' ? key : undefined;
      },
      clearPark() {
        key = undefined;
      },
    };

    // A second `Inbox` instance on the same directory, standing in for a separate `forge
    // answer` process: it never calls the engine or the worker directly, only the file.
    const answerFromAnotherProcess = () => {
      const outside = new Inbox(inboxDir);
      const waiting = outside.open()[0];
      if (waiting) outside.answer(waiting.key, 'go with dev');
    };

    const brief = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    const exec = async (request: { argv: string[] }) => ({
      ok: true, tail: '', returncode: 0, argv: request.argv, owner: 'alpha', startedAt: 0, durationMs: 1,
    });

    const worker = new Worker({
      run: 'alpha', brief, briefPath: join(dir, 'brief.md'), cwd: dir, journalPath,
      engine: engine as never, exec, pollIntervalMs: 10,
    } as never) as unknown as {
      run: () => Promise<{ verdict: string; sessions: string[]; handoffs: number }>;
    };

    // Answered after the worker has already polled once and found nothing, so the round
    // trip only succeeds if the wait is a real poll rather than a single check.
    setTimeout(answerFromAnotherProcess, 15);

    const result = await worker.run();

    expect(result.verdict).toBe('done');
    expect(result.sessions).toHaveLength(1);
    expect(result.handoffs).toBe(0);
    expect(resumedPrompt).toContain('go with dev');

    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.resumed' && e.run === 'alpha')).toBe(true);
    // The falsifier this closes: a run that ever reports stopped or exhausted while it was
    // genuinely parked defeats the point, whatever its final verdict turns out to be.
    expect(state.events.some((e) => e.event === 'run.finished'
      && (e['verdict'] === 'stopped' || e['verdict'] === 'exhausted'))).toBe(false);
  });

  it('the falsifier: with no parkedOn on the engine, a zero-turn segment still reads as a plain stop', async () => {
    // Same shape (zero turns, nothing done), but the engine never says the run is parked.
    // This has to keep behaving exactly as it did before F1, proving the new wait only
    // fires because the engine names a park key, never merely because turns came back empty.
    const engine = {
      started: [] as unknown[],
      async run(config: { run: string }) {
        this.started.push(config);
        return { sessionId: 'session-1', turns: [] };
      },
    };
    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: engine as never,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    const result = await worker.run();
    expect(['exhausted', 'parked']).toContain(result.verdict);
  });
});

describe('P4.7/I8: forge stop --all must reach a live run from another process', () => {
  it('a kill switch seen mid-turn parks the chain with a packet, never continuing to a successor', async () => {
    const worker = makeWorker([climbing(1_000, 5)], { maxContext: 60_000, killSwitch: () => true });

    const result = await worker.run();

    expect(result.verdict).toBe('parked');
    expect(worker.engine.started).toHaveLength(1);
    expect(worker.engine.sent).toHaveLength(1);
    expect(worker.engine.sent[0]?.prompt).toContain('CONTEXT CEILING REACHED');
    const state = replay(journalPath);
    const parked = state.events.find((e) => e.event === 'run.parked' && e.run === 'alpha');
    expect(parked?.['reason']).toBe('kill switch engaged');
    expect(parked?.['packet']).toBe('packet for session-1');
  });

  it('leaves an ordinary chain alone when the kill switch is never engaged', async () => {
    const worker = makeWorker([climbing(1_000, 5)], { maxContext: 60_000 });
    const result = await worker.run();
    expect(result.verdict).not.toBe('parked');
  });

  it('a run parked on an ask ends its wait, parked, with a packet, when the kill switch appears', async () => {
    const inboxDir = join(dir, 'inbox');
    const inbox = new Inbox(inboxDir);
    let key: string | undefined;

    const engine = {
      started: [] as unknown[],
      inbox,
      async run(config: { run: string }) {
        this.started.push(config);
        const entry = inbox.raise({
          run: config.run, goal: config.run, actionTarget: 'AskUserQuestion',
          question: 'dev or prod?', options: ['dev', 'prod'], kind: 'question',
        });
        key = entry.key;
        return {
          sessionId: 'session-1',
          turns: [],
          async send(prompt: string) {
            return [{ text: `packet: ${prompt.slice(0, 10)}`, context: 0 }];
          },
        };
      },
      parkedOn(run: string) {
        return run === 'alpha' ? key : undefined;
      },
      clearPark() { key = undefined; },
    };

    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: engine as never, pollIntervalMs: 10,
      // Engaged from the very first poll: this run is never answered, only stopped.
      killSwitch: () => true,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    const result = await worker.run();

    expect(result.verdict).toBe('parked');
    const state = replay(journalPath);
    const parked = state.events.find((e) => e.event === 'run.parked'
      && e.run === 'alpha' && e['reason'] === 'kill switch engaged while parked');
    expect(parked).toBeTruthy();
    expect(parked?.['packet']).toBeTruthy();
    // The falsifier this closes: a run stopped while parked must never sit silent behind
    // only the bare `run.finished` a plain unanswered park already left.
    expect(state.events.some((e) => e.event === 'run.finished' && e['verdict'] === 'parked')).toBe(true);
  });

  it('P4.7/I8 regression: stop --all then clear --all then a park still resumes on a real answer', async () => {
    // Reproduces the 2026-09-04 sequence a dispatcher review found: a stop that never
    // reaches a run, a clear, a park, and then an answer from a second process. The kill
    // switch must be off again by the time the park starts, so the wait ends on the
    // answer, not on a stale kill switch.
    const home = mkdtempSync(join(tmpdir(), 'forge-home-'));
    const killSwitchFile = join(home, 'kill-switch.json');
    const inboxDir = join(dir, 'inbox');
    const inbox = new Inbox(inboxDir);
    let key: string | undefined;
    let resumedPrompt: string | undefined;

    const engine = {
      started: [] as unknown[],
      inbox,
      async run(config: { run: string }) {
        this.started.push(config);
        const entry = inbox.raise({
          run: config.run, goal: config.run, actionTarget: 'AskUserQuestion',
          question: 'dev or prod?', options: ['dev', 'prod'], kind: 'question',
        });
        key = entry.key;
        return {
          sessionId: 'session-1',
          turns: [],
          async send(prompt: string) {
            resumedPrompt = prompt;
            return [{ text: 'shipped', context: 10, done: true }];
          },
        };
      },
      parkedOn(run: string) { return run === 'alpha' ? key : undefined; },
      clearPark() { key = undefined; },
    };

    // A `forge stop --all` from another process, before this run ever parks: no live
    // registry row exists for it yet, so it reaches nothing and is a no-op here, exactly
    // as the incident's own timeline had it (stop, then clear, then the park).
    const registry = new Registry(join(home, 'registry'));
    const lanes = new Lanes(join(home, 'lanes'));
    await new Fleet(lanes, registry, join(home, 'fleet.jsonl'), killSwitchFile).stopAll('probe');
    expect(readKillSwitch(killSwitchFile).engaged).toBe(true);
    clearKillSwitch(killSwitchFile);
    expect(readKillSwitch(killSwitchFile).engaged).toBe(false);

    const brief = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    const exec = async (request: { argv: string[] }) => ({
      ok: true, tail: '', returncode: 0, argv: request.argv, owner: 'alpha', startedAt: 0, durationMs: 1,
    });

    const worker = new Worker({
      run: 'alpha', brief, briefPath: join(dir, 'brief.md'), cwd: dir, journalPath,
      engine: engine as never, exec, pollIntervalMs: 10,
      killSwitch: () => readKillSwitch(killSwitchFile).engaged,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    const answerFromAnotherProcess = () => {
      const outside = new Inbox(inboxDir);
      const waiting = outside.open()[0];
      if (waiting) outside.answer(waiting.key, 'go with dev');
    };
    setTimeout(answerFromAnotherProcess, 15);

    const result = await worker.run();

    expect(result.verdict).toBe('done');
    expect(resumedPrompt).toContain('go with dev');
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.finished'
      && (e['verdict'] === 'stopped' || e['verdict'] === 'exhausted'))).toBe(false);
  });
});

describe('P4.7/I3: the Governor checks a run does not drift on every turn', () => {
  it('parks the run in the very turn a served model does not match its class, through the Warden actuator', async () => {
    const parked: Array<{ run: string; reason: string }> = [];
    const actuator = {
      park: async (run: string, reason: string) => { parked.push({ run, reason }); },
      nudge: async () => {},
      resume: async () => {},
      kill: async () => {},
    };
    const engine = fakeEngine([[
      { text: 'first turn', context: 100, model: 'claude-opus-5' },
      { text: 'second turn, never reached', context: 200 },
    ]]);
    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine, actuator,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    const result = await worker.run();

    expect(parked).toHaveLength(1);
    expect(parked[0]!.run).toBe('alpha');
    expect(result.verdict).toBe('parked');
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'warden.parked' && event.run === 'alpha');
    expect(row).toBeTruthy();
    expect(row?.['actualModel']).toBe('claude-opus-5');
    // Only the first, mismatched turn is journaled; the loop stops before a second turn
    // the model would otherwise have taken on the wrong tier.
    expect(state.events.filter((event) => event.event === 'turn.end' && event.run === 'alpha')).toHaveLength(1);
  });

  it('never parks a run whose served model matches its class', async () => {
    const parked: string[] = [];
    const actuator = {
      park: async (run: string) => { parked.push(run); },
      nudge: async () => {}, resume: async () => {}, kill: async () => {},
    };
    const engine = fakeEngine([[{ text: 'on task', context: 100, model: 'claude-sonnet-5', done: true }]]);
    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine, actuator,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    await worker.run();
    expect(parked).toHaveLength(0);
  });
});

describe('P4.7/I3: a rate-limit engine.error pauses through the Governor\'s WindowGate', () => {
  it('journals run.paused with the resolved resumeAt, for a rate-limit-shaped error', async () => {
    const engine = {
      started: [] as unknown[],
      async run(config: { run: string }) {
        this.started.push(config);
        throw new Error('429 too many requests, try again later');
      },
    };
    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: engine as never,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    const result = await worker.run();
    expect(result.verdict).toBe('exhausted');
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'run.paused' && event.run === 'alpha');
    expect(row).toBeTruthy();
    expect(typeof row?.['resumeAt']).toBe('number');
    expect(row?.['resumeAt'] as number).toBeGreaterThan(Date.now());
  });

  it('an ordinary engine error carries no resumeAt', async () => {
    const engine = {
      started: [] as unknown[],
      async run(config: { run: string }) {
        this.started.push(config);
        throw new Error('the child process exited with code 1');
      },
    };
    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: engine as never,
    } as never) as unknown as { run: () => Promise<{ verdict: string }> };

    await worker.run();
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'run.paused' && event.run === 'alpha');
    expect(row?.['resumeAt']).toBeUndefined();
  });
});

describe('I14: a segment that ends with no done, ceiling, park or kill gets one nudge before it gives up', () => {
  it('sends up to two nudges on the same session, then reports stopped, never a third', async () => {
    const worker = makeWorker([[{ text: 'idle', context: 100 }]], { maxContext: 60_000 });
    await worker.run();

    // Two sends, not zero and not three: NUDGE_LIMIT is exactly two.
    expect(worker.engine.sent).toHaveLength(2);
    const state = replay(journalPath);
    const nudges = state.events.filter((event) => event.event === 'run.nudged' && event.run === 'alpha');
    expect(nudges).toHaveLength(2);
    expect(nudges[0]?.['reason']).toMatch(/forge_done/);
    expect(nudges[1]?.['attempt']).toBe(2);
    const finished = state.events.find((event) => event.event === 'run.finished' && event.run === 'alpha');
    expect(finished?.['verdict']).not.toBe('done');
  });

  it('sends the nudge on the open session, never a fresh one', async () => {
    const worker = makeWorker([[{ text: 'idle', context: 100 }]], { maxContext: 60_000 });
    await worker.run();

    // A fresh session would be a second `engine.started` entry; there is only the one.
    expect(worker.engine.started).toHaveLength(1);
  });

  it('never nudges a session that already ended in done, a park, a kill or a handoff', async () => {
    const worker = makeWorker(
      [[{ text: 'done', context: 10, done: true }]],
      { maxContext: 60_000 },
    );
    await worker.run();

    const state = replay(journalPath);
    expect(state.events.some((event) => event.event === 'run.nudged')).toBe(false);
  });

  it('quotes the rule.denied reason when the segment ends right after one', async () => {
    let calls = 0;
    const engine = {
      started: [] as unknown[],
      sent: [] as string[],
      async run(config: { run: string }) {
        this.started.push(config);
        const journal = new Journal(journalPath);
        journal.append({
          event: 'rule.denied', run: config.run, actor: 'runner', tool: 'Edit',
          rule: 'humanizer', reason: 'Carries an em dash', sink: 'edit', path: '/repo/docs/x.md',
        });
        journal.close();
        return {
          sessionId: 'session-1', turns: [{ text: 'trying again', context: 10 }],
          send: async (prompt: string) => {
            calls += 1;
            this.sent.push(prompt);
            return [{ text: 'still trying', context: 10 }];
          },
        };
      },
    };
    const worker = new Worker({
      run: 'alpha', brief: '# Goal\n\nDo the thing.\n', briefPath: join(dir, 'brief.md'),
      cwd: dir, journalPath, engine: engine as never, maxContext: 60_000,
    } as never) as unknown as { run: () => Promise<unknown> };

    await worker.run();

    expect(calls).toBeGreaterThan(0);
    const state = replay(journalPath);
    const nudges = state.events.filter((event) => event.event === 'run.nudged' && event.run === 'alpha');
    expect(nudges[0]?.['reason']).toContain('Carries an em dash');
  });
});
