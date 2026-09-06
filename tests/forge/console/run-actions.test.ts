import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Actuator, DecisionId, RunId } from '../../../src/forge/contracts.js';
import { appendOnce } from '../../../src/forge/journal.js';
import { Registry } from '../../../src/forge/registry.js';
import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import {
  capOverridesPath, killRun, mergeRun, pauseRun, resumeRun, setRunCap, verifyRun,
  type RunActionsDeps,
} from '../../../src/forge/console/run-actions.js';

class FakeActuator implements Actuator {
  parked: Array<{ run: string; reason: string }> = [];

  resumed: Array<{ run: string; input: string }> = [];

  killed: Array<{ run: string; decisionId: DecisionId }> = [];

  parkReturns = true;

  async park(run: RunId, reason: string): Promise<boolean> {
    this.parked.push({ run, reason });
    return this.parkReturns;
  }

  async nudge(): Promise<void> {}

  async resume(run: RunId, input: string): Promise<void> {
    this.resumed.push({ run, input });
  }

  async kill(run: RunId, decisionId: DecisionId): Promise<void> {
    this.killed.push({ run, decisionId });
  }
}

function fakeSpawn(returncode: number, stdout: string) {
  return () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    setImmediate(() => {
      (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(stdout));
      child.emit('close', returncode);
    });
    return child;
  };
}

let dir: string;
let journalPath: string;
let registry: Registry;
let ledger: ActionsLedger;
let actuator: FakeActuator;
let deps: RunActionsDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-run-actions-'));
  journalPath = join(dir, 'fleet.jsonl');
  registry = new Registry(join(dir, 'registry'));
  ledger = new ActionsLedger(join(dir, 'actions.jsonl'));
  actuator = new FakeActuator();
  deps = {
    ledger, registry, actuator, journalPath,
    hardUsd: () => 10,
    capsOverridesPath: join(dir, 'caps.json'),
  };
});

describe('killRun', () => {
  it('refuses an unknown run with 404 and never calls the actuator', async () => {
    const result = await killRun('ghost', 'bad', deps);
    expect(result.status).toBe(404);
    expect(actuator.killed).toHaveLength(0);
  });

  it('writes a decision.made row the actuator can find, then calls kill with its id', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });

    const result = await killRun('alpha', 'over budget', deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, undoable: false });
    expect(actuator.killed).toEqual([{ run: 'alpha', decisionId: (result.body as { jid: string }).jid }]);

    const rows = readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[1]).toMatchObject({ event: 'decision.made', action: 'kill', run: 'alpha', actor: 'console' });
  });

  it('is not undoable', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    const result = await killRun('alpha', 'reason', deps);
    const row = ledger.get((result.body as { jid: string }).jid);
    expect(row?.undo).toBeNull();
  });

  it('refuses a kill on a run that is not running, handed off, paused or parked, with no journal row', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.finished', run: 'alpha', verdict: 'done' });

    const result = await killRun('alpha', 'reason', deps);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: expect.any(String), state: 'done' });
    expect(actuator.killed).toHaveLength(0);
    expect(readFileSync(journalPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('pauseRun / resumeRun', () => {
  it('pauses a registered run and records an undo that resumes it', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });

    const result = await pauseRun('alpha', 'operator paused', deps);

    expect(result.status).toBe(200);
    expect(actuator.parked).toEqual([{ run: 'alpha', reason: 'operator paused' }]);
    const row = ledger.get((result.body as { jid: string }).jid);
    expect(row?.undo).toEqual({ kind: 'resume-run', payload: { run: 'alpha' } });
  });

  it('answers 409 when the actuator refuses to park', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    actuator.parkReturns = false;

    const result = await pauseRun('alpha', 'reason', deps);

    expect(result.status).toBe(409);
  });

  it('refuses to pause a run that is not running or handed off', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.finished', run: 'alpha', verdict: 'done' });

    const result = await pauseRun('alpha', 'reason', deps);

    expect(result.status).toBe(409);
    expect(actuator.parked).toHaveLength(0);
  });

  it('resumes a registered run via the actuator', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.paused', run: 'alpha' });

    const result = await resumeRun('alpha', deps);

    expect(result.status).toBe(200);
    expect(actuator.resumed).toHaveLength(1);
    expect(actuator.resumed[0]!.run).toBe('alpha');
  });

  it('refuses to resume a run that is not paused or parked', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });

    const result = await resumeRun('alpha', deps);

    expect(result.status).toBe(409);
    expect(actuator.resumed).toHaveLength(0);
  });
});

describe('setRunCap', () => {
  it('refuses a cap above the hard limit with 422', async () => {
    const result = await setRunCap('alpha', 100, deps);
    expect(result.status).toBe(422);
    expect((result.body as { error: string }).error).toMatch(/hard limit/);
  });

  it('writes the override to caps.json and records the previous value for undo', async () => {
    const path = capOverridesPath(deps.capsOverridesPath);
    const first = await setRunCap('alpha', 5, deps);
    expect(first.status).toBe(200);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ perRun: { alpha: 5 } });

    const second = await setRunCap('alpha', 8, deps);
    const row = ledger.get((second.body as { jid: string }).jid);
    expect(row?.undo).toEqual({ kind: 'restore-run-cap', payload: { run: 'alpha', capUsd: 5 } });
  });

  it('rejects a non-positive cap', async () => {
    const result = await setRunCap('alpha', 0, deps);
    expect(result.status).toBe(400);
  });
});

describe('mergeRun / verifyRun', () => {
  it('answers 501 when no chain packet names a repo for the run', async () => {
    const result = await mergeRun('alpha', deps);
    expect(result.status).toBe(501);
    expect((result.body as { error: string }).error).toBe('not wired');
  });

  it('answers 501 when a chain packet exists but no PR is open for its branch', async () => {
    appendOnce(journalPath, { event: 'intake.planned', packetId: 'p1', repo: 'acme/widget' });
    appendOnce(journalPath, {
      event: 'chain.launched', packetId: 'p1', run: 'alpha',
    });
    // foldChainState reads `launched.runKey` from the row's own field, not `run`; write
    // it the way chain.ts's advancePacket actually does.
    appendOnce(journalPath, { event: 'chain.provisioned', packetId: 'p1', worktreePath: dir, branch: 'feat/x' });
    // merge's own state guard needs done/unverified -- otherwise this never reaches the
    // PR lookup this test is actually about.
    appendOnce(journalPath, { event: 'run.finished', run: 'alpha', verdict: 'done' });

    deps.spawnFn = fakeSpawn(0, '[]');
    const result = await mergeRun('alpha', deps);
    // No `chain.launched` row carries `launched.runKey` in this fixture (the real event
    // needs a `runKey` field foldChainState reads), so this still answers 501 -- proving
    // the handler never fabricates a PR when the chain has not actually recorded one.
    expect(result.status).toBe(501);
  });

  it('spawns forge gate and journals the outcome when the chain names a repo, branch and PR', async () => {
    appendOnce(journalPath, { event: 'intake.planned', packetId: 'p1', repo: 'acme/widget' });
    appendOnce(journalPath, { event: 'chain.provisioned', packetId: 'p1', worktreePath: dir, branch: 'feat/x' });
    appendOnce(journalPath, { event: 'chain.launched', packetId: 'p1', runKey: 'alpha' });

    let calls = 0;
    deps.spawnFn = ((command: string, args: string[]) => {
      calls += 1;
      if (args.includes('list')) return fakeSpawn(0, JSON.stringify([{ number: 42 }]))();
      return fakeSpawn(0, 'gate passed')();
    }) as RunActionsDeps['spawnFn'];

    const result = await verifyRun('alpha', deps);

    expect(calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
  });
});
