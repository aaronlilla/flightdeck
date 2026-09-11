/**
 * `worktreeStatusForAsync` must not block the event loop: the code-sync worktree sweep
 * probes ~90 worktrees, and the synchronous `execFileSync` version froze the whole Node
 * process for the length of the sweep (the specimen behind the re-sync freeze, 2026-09-11).
 * This proves a concurrent timer keeps firing while the probe is in flight.
 */
import { describe, expect, it } from 'vitest';

import type { RunRequest, RunResult } from '../../../src/forge/exec.js';
import { worktreeStatusForAsync } from '../../../src/forge/sessions/cleanup.js';

function result(argv: string[], stdout: string): RunResult {
  return { owner: 't', argv, returncode: 0, tail: stdout, full: stdout, startedAt: 0, durationMs: 1, ok: true };
}

describe('worktreeStatusForAsync', () => {
  it('yields to the event loop between git calls instead of blocking it', async () => {
    // Each git read resolves on a macrotask, the way a real spawn does. A synchronous
    // execFileSync could not do this -- the loop would be pinned until the subprocess
    // returned, and the tick counter below would stay at zero.
    const execRun = (request: RunRequest): Promise<RunResult> => new Promise((resolve) => {
      const argv = request.argv;
      let out = '';
      if (argv.includes('rev-parse')) out = '/repo/wt';
      else if (argv.includes('status')) out = '';
      else if (argv.includes('rev-list')) out = '0';
      setTimeout(() => resolve(result(argv, out)), 5);
    });

    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);

    const status = await worktreeStatusForAsync('s', '/repo/wt', execRun);
    clearInterval(timer);

    expect(status).toEqual({ path: '/repo/wt', clean: true, pushed: true });
    // Three git reads at 5ms each, with a 1ms interval free to fire throughout: a blocked
    // loop would leave ticks at 0.
    expect(ticks).toBeGreaterThan(0);
  });

  it('reads unclean and unpushed from the git output', async () => {
    const execRun = async (request: RunRequest): Promise<RunResult> => {
      const argv = request.argv;
      if (argv.includes('rev-parse')) return result(argv, '/repo/wt');
      if (argv.includes('status')) return result(argv, ' M src/x.ts');
      // rev-list fails: no upstream -> not pushed.
      return { ...result(argv, ''), ok: false, returncode: 128 };
    };

    const status = await worktreeStatusForAsync('s', '/repo/wt', execRun);
    expect(status).toEqual({ path: '/repo/wt', clean: false, pushed: false });
  });

  it('returns undefined when the cwd is not a worktree', async () => {
    const execRun = async (request: RunRequest): Promise<RunResult> => ({
      ...result(request.argv, ''), ok: false, returncode: 128,
    });
    expect(await worktreeStatusForAsync('s', '/not/a/repo', execRun)).toBeUndefined();
    expect(await worktreeStatusForAsync('s', undefined, execRun)).toBeUndefined();
  });
});
