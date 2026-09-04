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
import { replay } from '../../src/forge/journal.js';

let dir: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-worker-'));
  journalPath = join(dir, 'fleet.jsonl');
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
