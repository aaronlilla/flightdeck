/**
 * Long-running commands, run under a budget and killed as a tree.
 *
 * A worker that shells out has no idea how long anything takes, so a build that hangs
 * hangs the run. The supervisor owns the clock instead: a wall budget for total time, an
 * idle budget for time since the last byte of output, and a dump when either runs out so
 * the next reader has the tail rather than a shrug.
 *
 * The tree kill is the part that is hard on Windows and easy to get wrong. Killing the
 * process leaves its children running: npm spawns node, gradle spawns java, and both
 * outlive a plain kill. `taskkill /F /T` takes the tree. The specimen that matters is a
 * command that spawns a child and outlives its parent.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { CLASS_BUDGETS, budgetsFor, killTree, run } from '../../src/forge/exec.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-exec-'));
});

describe('budgets', () => {
  it('carries the class budgets: the five from Phase 1 plus B.3.4 verify', () => {
    expect(Object.keys(CLASS_BUDGETS).sort())
      .toEqual(['build', 'goal', 'install', 'script', 'test', 'verify']);
  });

  it('gives every class a wall and an idle budget', () => {
    for (const [name, budget] of Object.entries(CLASS_BUDGETS)) {
      expect(budget.wall, name).toBeGreaterThan(0);
      expect(budget.idle, name).toBeGreaterThan(0);
      expect(budget.idle, name).toBeLessThanOrEqual(budget.wall);
    }
  });

  it('falls back to script for a class nobody declared', () => {
    expect(budgetsFor('no-such-class')).toEqual(CLASS_BUDGETS['script']);
  });

  it('lets a call override its own budget without editing the table', () => {
    expect(budgetsFor('test', { wall: 5 }).wall).toBe(5);
    expect(budgetsFor('test', { wall: 5 }).idle).toBe(CLASS_BUDGETS['test']?.idle);
  });
});

describe('running a command', () => {
  it('returns its output and exit code', async () => {
    const result = await run({ argv: ['node', '-e', 'console.log("hello")'], cwd: dir, owner: 'r1' });
    expect(result.ok).toBe(true);
    expect(result.returncode).toBe(0);
    expect(result.tail).toContain('hello');
    expect(result.killed).toBeUndefined();
  });

  it('reports a failure as a failure rather than throwing', async () => {
    const result = await run({ argv: ['node', '-e', 'process.exit(3)'], cwd: dir, owner: 'r1' });
    expect(result.ok).toBe(false);
    expect(result.returncode).toBe(3);
  });

  it('writes a log a viewer can hold open while it runs', async () => {
    const result = await run({
      argv: ['node', '-e', 'console.log("written")'], cwd: dir, owner: 'r1', logDir: dir,
    });
    expect(readFileSync(result.logPath!, 'utf8')).toContain('written');
  });

  it('says plainly when the binary does not exist', async () => {
    const result = await run({ argv: ['definitely-not-a-real-binary-xyz'], cwd: dir, owner: 'r1' });
    expect(result.ok).toBe(false);
    expect(result.tail.toLowerCase()).toMatch(/enoent|not recognized|not found/);
  });
});

describe('budgets that run out', () => {
  it('kills a command that outlives its wall budget and says so', async () => {
    const result = await run({
      argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
      cwd: dir, owner: 'r1', wall: 1, idle: 60,
    });
    expect(result.killed).toBe('wall');
    expect(result.ok).toBe(false);
  }, 20_000);

  it('kills a command that goes quiet past its idle budget', async () => {
    const result = await run({
      argv: ['node', '-e', 'console.log("start"); setInterval(() => {}, 1000)'],
      cwd: dir, owner: 'r1', wall: 60, idle: 1,
    });
    expect(result.killed).toBe('idle');
    expect(result.tail).toContain('start');
  }, 20_000);

  it('does not kill a slow command that keeps talking', async () => {
    const result = await run({
      argv: ['node', '-e',
        'let n = 0; const t = setInterval(() => { console.log(n); if (++n > 4) { clearInterval(t); } }, 200);'],
      cwd: dir, owner: 'r1', wall: 30, idle: 3,
    });
    expect(result.killed).toBeUndefined();
    expect(result.ok).toBe(true);
  }, 20_000);

  it('writes a dump with the tail so the kill is diagnosable', async () => {
    const result = await run({
      argv: ['node', '-e', 'console.log("before the hang"); setInterval(() => {}, 1000)'],
      cwd: dir, owner: 'r1', wall: 1, idle: 60, logDir: dir,
    });
    const dump = readFileSync(result.dumpPath!, 'utf8');
    expect(dump).toContain('before the hang');
    expect(dump).toMatch(/wall/);
  }, 20_000);
});

describe('B.3.9: killTree is latched, not fired every tick', () => {
  it('calls killFn twice (one attempt, one retry), never once per 250ms tick', async () => {
    const calls: number[] = [];
    const donePromise = run({
      argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
      cwd: dir, owner: 'r1', wall: 1, idle: 60,
      killFn: (pid) => { calls.push(pid); },
    });
    // The fake killFn never actually ends the process, so the budget stays tripped and
    // the tick keeps firing well past the point a real kill would have landed -- which is
    // exactly what proves the latch: without it, calls would keep growing here.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(1);

    killTree(calls[0]!);
    await donePromise;
  }, 20_000);
});

describe('killing the tree, not the process', () => {
  it('takes the children with it', async () => {
    // The grandchild is detached on purpose, and that detail is the whole specimen.
    // Node puts an ordinary child in the parent's job object, so killing the parent
    // already takes it: measured on this machine, a plain kill and taskkill /F /T are
    // indistinguishable in that case, and a specimen built on it proves nothing. A
    // detached grandchild breaks out of the job, survives a plain kill, and dies under
    // taskkill /F /T. That is npm and gradle in miniature.
    const script = [
      'const { spawn } = require("child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], '
        + '{ detached: true, stdio: "ignore" });',
      'child.unref();',
      'console.log("CHILD " + child.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const result = await run({ argv: ['node', '-e', script], cwd: dir, owner: 'r1', wall: 2, idle: 60 });
    expect(result.killed).toBe('wall');

    const childPid = Number(/CHILD (\d+)/.exec(result.tail)?.[1]);
    expect(Number.isFinite(childPid)).toBe(true);
    // Give the tree kill a moment to land, then ask the operating system.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const stillAlive = isAlive(childPid);
    if (stillAlive) killTree(childPid);
    expect(stillAlive).toBe(false);
  }, 30_000);

  it('is a no-op on a pid that has already gone', () => {
    expect(() => killTree(999_999)).not.toThrow();
  });
});

/** Whether a pid exists, asked of the operating system rather than of our own bookkeeping. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
