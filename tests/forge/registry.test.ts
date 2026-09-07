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
import { readParkRecord, writeParkRecord } from '../../src/forge/parkrecord.js';
import {
  processAlive, reapableGoals, reconcileRegistry, relaunchAbandonedGoal, Registry,
} from '../../src/forge/registry.js';
import type { EngineLike, SessionRequest } from '../../src/forge/worker.js';

let dir: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-registry-'));
  journalPath = join(dir, 'fleet.jsonl');
  // I13: `reconcileRegistry` now clears a resumed row's park record, which resolves
  // through `forgeHome()`'s real `~/.forge` fallback when unset -- pinned to this
  // test's own temp directory so that clear never reaches outside it.
  process.env['FORGE_HOME'] = dir;
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

  it('leaves a run parked on an open ask alone: the answer resumes it, not the reconcile', async () => {
    const briefPath = join(dir, 'asking.md');
    writeFileSync(briefPath, '# Goal', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'asking', cwd: dir, briefPath, pid: 999_999 });
    registry.setSession('asking', 'sess-asking', 'claude-sonnet-5');

    const engine = fakeEngine();
    const journal = new Journal(journalPath);
    const outcomes = await reconcileRegistry(registry, engine, journal, undefined, undefined, (goal) => goal === 'asking');
    journal.close();

    expect(outcomes).toEqual([{ goal: 'asking', ok: false, reason: 'parked on an open ask; the answer resumes it' }]);
    expect(engine.started).toHaveLength(0);
    expect(registry.get('asking')).toBeDefined();
  });

  it('I13: clears a stale park record when resuming a crashed run under the same name', async () => {
    const briefPath = join(dir, 'was-parked.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'was-parked', cwd: dir, briefPath, pid: 999_999 });
    registry.setSession('was-parked', 'sess-before-crash', 'claude-sonnet-5');
    writeParkRecord('was-parked', { key: 'warden:was-parked', reason: 'idle for 300s', at: Date.now() });

    const engine = fakeEngine();
    const journal = new Journal(journalPath);
    await reconcileRegistry(registry, engine, journal);
    journal.close();

    expect(readParkRecord('was-parked')).toBeUndefined();
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

  it('never resumes a run the journal already records as killed, even with a session id on file', async () => {
    const briefPath = join(dir, 'was-killed.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'was-killed', cwd: dir, briefPath, pid: 999_999 });
    registry.setSession('was-killed', 'sess-before-kill', 'claude-sonnet-5');

    const journal = new Journal(journalPath);
    // The kill happened while the process was still up (the row's pid is only stale by
    // the time `forge up` runs the reconcile pass) -- the journal outlives the process.
    journal.append({ event: 'run.killed', run: 'was-killed', actor: 'warden', decisionId: 'dec-1' });

    const engine = fakeEngine();
    const outcomes = await reconcileRegistry(registry, engine, journal);
    journal.close();

    expect(outcomes).toEqual([{ goal: 'was-killed', ok: false, reason: expect.stringContaining('killed') }]);
    expect(engine.started).toHaveLength(0);
    expect(registry.get('was-killed')).toBeUndefined();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.resumed' && e.run === 'was-killed')).toBe(false);
    // The falsifier this closes: a resurrected run whose new events push `run.killed`
    // out of "last own event" and leave the tile reading `running` forever.
    expect(state.runs['was-killed']?.state).not.toBe('started');
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

describe('B.2: relaunchAbandonedGoal', () => {
  function fakeEngine(): EngineLike & { started: SessionRequest[] } {
    return {
      started: [],
      async run(config: SessionRequest) {
        this.started.push(config);
        return { sessionId: config.resume ?? 'new-session', turns: [] };
      },
    };
  }

  it('resumes by session id, on the same cwd, and leaves the registry row untouched', async () => {
    const briefPath = join(dir, 'mid-tool.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'mid-tool', cwd: dir, briefPath, pid: 999_999 });
    registry.setSession('mid-tool', 'sess-mid-tool', 'claude-sonnet-5');

    const engine = fakeEngine();
    const outcome = await relaunchAbandonedGoal(registry, engine, 'mid-tool');

    expect(outcome).toBe('relaunched');
    expect(engine.started).toHaveLength(1);
    expect(engine.started[0]?.resume).toBe('sess-mid-tool');
    expect(engine.started[0]?.cwd).toBe(dir);
    // The row survives: a second death under the same name must still be able to trip
    // the same registry-abandoned signal, which needs the row to still be there.
    expect(registry.get('mid-tool')).toBeDefined();
  });

  it('skips a goal with no registry row at all', async () => {
    const registry = new Registry(join(dir, 'registry'));
    const engine = fakeEngine();
    const outcome = await relaunchAbandonedGoal(registry, engine, 'nowhere');
    expect(outcome).toBe('skipped');
    expect(engine.started).toHaveLength(0);
  });

  it('skips a goal with a row but no recorded session id -- nothing to resume by', async () => {
    const briefPath = join(dir, 'no-session-mid-tool.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'no-session-mid-tool', cwd: dir, briefPath, pid: 999_999 });

    const engine = fakeEngine();
    const outcome = await relaunchAbandonedGoal(registry, engine, 'no-session-mid-tool');
    expect(outcome).toBe('skipped');
    expect(engine.started).toHaveLength(0);
  });

  it('a throwing engine reads as skipped rather than propagating', async () => {
    const briefPath = join(dir, 'throws.md');
    writeFileSync(briefPath, '# Goal\n\nDo the thing.\n', 'utf8');
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'throws', cwd: dir, briefPath, pid: 999_999 });
    registry.setSession('throws', 'sess-throws', 'claude-sonnet-5');

    const engine: EngineLike = { started: [], run: async () => { throw new Error('sdk exploded'); } };
    const outcome = await relaunchAbandonedGoal(registry, engine, 'throws');
    expect(outcome).toBe('skipped');
  });
});

describe('B.3: reapableGoals', () => {
  const FOUR_HOURS = 4 * 60 * 60_000;

  it('never reaps a row whose pid is alive', () => {
    const rows = [{ goal: 'a', cwd: dir, briefPath: 'x', pid: 1, startedAt: 0 }];
    const goals = reapableGoals(rows, () => true, () => 0, FOUR_HOURS + 1, FOUR_HOURS);
    expect(goals).toEqual([]);
  });

  it('never reaps a dead row with no park record at all', () => {
    const rows = [{ goal: 'a', cwd: dir, briefPath: 'x', pid: 1, startedAt: 0 }];
    const goals = reapableGoals(rows, () => false, () => undefined, FOUR_HOURS + 1, FOUR_HOURS);
    expect(goals).toEqual([]);
  });

  it('never reaps a dead, parked row younger than the bound', () => {
    const rows = [{ goal: 'a', cwd: dir, briefPath: 'x', pid: 1, startedAt: 0 }];
    const goals = reapableGoals(rows, () => false, () => FOUR_HOURS - 1_000, FOUR_HOURS, FOUR_HOURS);
    expect(goals).toEqual([]);
  });

  it('reaps a dead, parked row at or past the 4 hour bound', () => {
    const rows = [{ goal: 'a', cwd: dir, briefPath: 'x', pid: 1, startedAt: 0 }];
    const goals = reapableGoals(rows, () => false, () => 0, FOUR_HOURS, FOUR_HOURS);
    expect(goals).toEqual(['a']);
  });

  it('reaps only the dead, old-enough rows out of a mixed set', () => {
    const rows = [
      { goal: 'alive', cwd: dir, briefPath: 'x', pid: 1, startedAt: 0 },
      { goal: 'young', cwd: dir, briefPath: 'x', pid: 2, startedAt: 0 },
      { goal: 'old', cwd: dir, briefPath: 'x', pid: 3, startedAt: 0 },
    ];
    const parkAt: Record<string, number | undefined> = { young: FOUR_HOURS - 1, old: 0 };
    const goals = reapableGoals(
      rows, (pid) => pid === 1, (goal) => parkAt[goal], FOUR_HOURS, FOUR_HOURS,
    );
    expect(goals).toEqual(['old']);
  });
});
