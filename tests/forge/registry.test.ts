/**
 * B.3.5: ownership before launch.
 *
 * Two runs for the same brief must not both be admitted, and a run whose process died
 * mid-flight must be picked back up by `forge up`, once, from its own session id.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Journal, replay } from '../../src/forge/journal.js';
import { processAlive, reconcileRegistry, Registry } from '../../src/forge/registry.js';
import type { EngineLike, SessionRequest } from '../../src/forge/worker.js';

let dir: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-registry-'));
  journalPath = join(dir, 'fleet.jsonl');
});

describe('admission', () => {
  it('admits the first run for a goal', () => {
    const registry = new Registry(join(dir, 'registry'));
    const verdict = registry.admit({
      goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid,
    });
    expect(verdict.ok).toBe(true);
  });

  it('B.3.5: refuses a second run for the same goal while the first is live', () => {
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });

    const second = registry.admit({
      goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid,
    });

    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already has a live run/);
  });

  it('B.3.5: refuses a second run in the same cwd under a different goal', () => {
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });

    const second = registry.admit({
      goal: 'beta', cwd: dir, briefPath: join(dir, 'beta.md'), pid: process.pid,
    });

    expect(second.ok).toBe(false);
  });

  it('admits a run once the earlier row belongs to a dead pid', () => {
    const registry = new Registry(join(dir, 'registry'));
    // A pid this high is not a running process on any machine this suite runs on.
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: 999_999 });
    registry.remove('alpha'); // forge up would have reconciled and cleared this row
    const second = registry.admit({
      goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid,
    });
    expect(second.ok).toBe(true);
  });

  it('B.3.5: the falsifier -- admission is not fooled by a lane file the second run rewrites', () => {
    // There is no lane involved here at all: admit() reads only the registry's own rows,
    // so a second run rewriting some other file (a lane) can never make this pass.
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    const second = registry.admit({
      goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid,
    });
    expect(second.ok).toBe(false);
  });

  it('processAlive reads a real pid as alive and a very unlikely one as dead', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(999_999)).toBe(false);
  });
});

describe('B.3.5: forge up reconciles a dead pid', () => {
  function fakeEngine(): EngineLike & { started: SessionRequest[] } {
    return {
      started: [],
      async run(config: SessionRequest) {
        this.started.push(config);
        return { sessionId: config.resume ?? 'new-session', turns: [] };
      },
    };
  }

  it('resumes a registry row whose pid is dead, exactly once, by session id', async () => {
    const briefPath = join(dir, 'crashed.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'crashed', cwd: dir, briefPath, pid: 999_999 });
    registry.setSession('crashed', 'sess-before-crash', 'claude-sonnet-5');

    const engine = fakeEngine();
    const journal = new Journal(journalPath);
    const outcomes = await reconcileRegistry(registry, engine, journal);
    journal.close();

    expect(outcomes).toEqual([{ goal: 'crashed', ok: true }]);
    expect(engine.started).toHaveLength(1);
    expect(engine.started[0]?.resume).toBe('sess-before-crash');
    expect(registry.get('crashed')).toBeUndefined();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.resumed' && e.run === 'crashed')).toBe(true);
  });

  it('leaves a row with a live pid alone', async () => {
    const briefPath = join(dir, 'alive.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'alive', cwd: dir, briefPath, pid: process.pid });
    registry.setSession('alive', 'sess-live', 'claude-sonnet-5');

    const engine = fakeEngine();
    const journal = new Journal(journalPath);
    const outcomes = await reconcileRegistry(registry, engine, journal);
    journal.close();

    expect(outcomes).toEqual([]);
    expect(engine.started).toHaveLength(0);
    expect(registry.get('alive')).toBeDefined();
  });

  it('reports, and drops, a dead row with no session id ever recorded', async () => {
    const briefPath = join(dir, 'no-session.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'no-session', cwd: dir, briefPath, pid: 999_999 });

    const engine = fakeEngine();
    const journal = new Journal(journalPath);
    const outcomes = await reconcileRegistry(registry, engine, journal);
    journal.close();

    expect(outcomes).toEqual([{ goal: 'no-session', ok: false, reason: expect.stringContaining('session id') }]);
    expect(registry.get('no-session')).toBeUndefined();
  });

  it('I12: a dead row with no session id older than the idle budget is journaled registry.abandoned and dropped', async () => {
    const briefPath = join(dir, 'abandoned.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'abandoned', cwd: dir, briefPath, pid: 999_999 });

    const engine = fakeEngine();
    const journal = new Journal(journalPath);
    // `abandonAfterMs: 0` puts every row past the budget the instant it is admitted --
    // the fixture stands in for a row old enough to be a genuine crash, since this
    // registry row has no way to control its own `startedAt` other than waiting.
    const outcomes = await reconcileRegistry(registry, engine, journal, undefined, 0);
    journal.close();

    expect(outcomes).toEqual([{ goal: 'abandoned', ok: false, reason: expect.stringContaining('session id') }]);
    expect(registry.get('abandoned')).toBeUndefined();
    const state = replay(journalPath);
    const rows = state.events.filter((e) => e.event === 'registry.abandoned' && e.run === 'abandoned');
    expect(rows).toHaveLength(1);
  });

  it('I12: a dead row with no session id, younger than the idle budget, is reported but not journaled as abandoned', async () => {
    const briefPath = join(dir, 'young.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'young', cwd: dir, briefPath, pid: 999_999 });

    const engine = fakeEngine();
    const journal = new Journal(journalPath);
    const outcomes = await reconcileRegistry(registry, engine, journal, undefined, 60 * 60_000);
    journal.close();

    expect(outcomes).toEqual([{ goal: 'young', ok: false, reason: expect.stringContaining('session id') }]);
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'registry.abandoned')).toBe(false);
  });
});
