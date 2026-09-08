/**
 * C1: the worktree setup command, run through a shell.
 *
 * `git worktree add` never needs a shell -- it is one argv, one binary, no chain
 * operator. The setup command is different: `FORGE_WORKTREE_SETUP` is whatever a
 * repository's own bootstrap needs, commonly more than one step joined with `&&`, and on
 * Windows `npm` is a `.cmd` shim a direct exec never finds. `runWorktreeSetup` isolates
 * just that step so a specimen can prove it without a real git checkout underneath it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  branchFor, readChainEnv, worktreePathFor, type ChainEnv,
} from '../../../src/forge/chain-env.js';
import {
  CHAIN_LAUNCH_CONDITION, chainLaunchArgv, chainLaunchGoalArgv, hasRunRegistered, launchWaitMs, provisionWorktree,
  runOutcome, runWorktreeSetup, waitForLaunchToRegister, type ProvisionFs,
} from '../../../src/forge/chain-wire.js';
import type { RunRequest, RunResult } from '../../../src/forge/exec.js';
import type { Registry } from '../../../src/forge/registry.js';

function envWith(overrides: Partial<ChainEnv>): ChainEnv {
  return { ...readChainEnv({}), worktreeSetup: [{ repo: 'owner/name', value: 'irrelevant' }], ...overrides };
}

describe('runWorktreeSetup', () => {
  it('does nothing when no FORGE_WORKTREE_SETUP entry matches the repo', async () => {
    const chainEnv = readChainEnv({});
    let called = false;
    await runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/wt',
      exec: async () => { called = true; return { ok: true } as RunResult; },
    });
    expect(called).toBe(false);
  });

  it('with no FORGE_WORKTREE_SHELL configured, runs the command with shell: true', async () => {
    let seen: RunRequest | undefined;
    const chainEnv = envWith({ worktreeSetup: [{ repo: 'owner/name', value: 'npm ci && npm run build' }] });
    await runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/wt',
      exec: async (request) => { seen = request; return { ok: true } as RunResult; },
    });
    expect(seen?.shell).toBe(true);
    expect(seen?.argv).toEqual(['npm ci && npm run build']);
  });

  it('with FORGE_WORKTREE_SHELL configured, runs the prefix followed by the command', async () => {
    let seen: RunRequest | undefined;
    const chainEnv = envWith({
      worktreeSetup: [{ repo: 'owner/name', value: 'npm ci && npm run build' }],
      shell: ['/bin/bash', '-c'],
    });
    await runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/wt',
      exec: async (request) => { seen = request; return { ok: true } as RunResult; },
    });
    expect(seen?.shell).toEqual(['/bin/bash', '-c']);
    expect(seen?.argv).toEqual(['npm ci && npm run build']);
  });

  it('the child\'s cwd is the worktree', async () => {
    let seen: RunRequest | undefined;
    const chainEnv = envWith({ worktreeSetup: [{ repo: 'owner/name', value: 'echo hi' }] });
    await runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/some/worktree',
      exec: async (request) => { seen = request; return { ok: true } as RunResult; },
    });
    expect(seen?.cwd).toBe('C:/some/worktree');
  });

  it('blocks with the command and the tail of its output when the setup fails', async () => {
    const chainEnv = envWith({ worktreeSetup: [{ repo: 'owner/name', value: 'npm run build' }] });
    await expect(runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/wt',
      exec: async () => ({ ok: false, tail: 'tsc: error TS1234 boom' } as RunResult),
    })).rejects.toThrow(/npm run build/);
    await expect(runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/wt',
      exec: async () => ({ ok: false, tail: 'tsc: error TS1234 boom' } as RunResult),
    })).rejects.toThrow(/TS1234 boom/);
  });

  it('a real run through the platform shell actually fails when the command fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-setup-'));
    const chainEnv = envWith({ worktreeSetup: [{ repo: 'owner/name', value: 'exit 1' }] });
    await expect(runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: dir,
    })).rejects.toThrow(/exit 1/);
  });

  it('a real run through the platform shell succeeds when the command succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-setup-'));
    const chainEnv = envWith({ worktreeSetup: [{ repo: 'owner/name', value: 'exit 0' }] });
    await expect(runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: dir,
    })).resolves.toBeUndefined();
  });
});

/**
 * D1: reuse of a worktree already on disk, against injected git and fs -- no real git
 * checkout underneath any of these.
 */
describe('provisionWorktree', () => {
  const repo = 'owner/name';
  const ticket = 'ABC-1';
  const checkout = '/checkouts/name';
  const branch = branchFor(ticket);
  const worktreePath = worktreePathFor(checkout, repo, ticket);

  function fakeFs(overrides: Partial<{ markerExists: boolean }> = {}): ProvisionFs {
    const markerExists = overrides.markerExists ?? false;
    return {
      existsSync: (p) => String(p).endsWith('forge-chain-setup-done') && markerExists,
      readFileSync: (() => { throw new Error('ENOENT: no such file'); }) as unknown as ProvisionFs['readFileSync'],
      writeFileSync: () => undefined,
      statSync: (() => { throw new Error('ENOENT: no such file'); }) as unknown as ProvisionFs['statSync'],
      mkdirSync: (() => undefined) as unknown as ProvisionFs['mkdirSync'],
    };
  }

  function listResult(entries: string): RunResult {
    return { ok: true, tail: entries } as RunResult;
  }

  it('fresh path: no worktree list entry runs git worktree add and setup', async () => {
    const calls: RunRequest[] = [];
    const chainEnv = envWith({
      checkouts: [{ repo, value: checkout }], worktreeSetup: [{ repo, value: 'npm ci' }],
    });
    const exec = async (request: RunRequest): Promise<RunResult> => {
      calls.push(request);
      if (request.argv.includes('list')) return listResult('');
      return { ok: true, tail: '' } as RunResult;
    };

    const result = await provisionWorktree({ chainEnv, repo, ticket, exec, fs: fakeFs() });

    expect(result).toMatchObject({ worktreePath, branch, reused: false });
    const add = calls.find((c) => c.argv.includes('add'));
    expect(add?.argv).toContain(worktreePath);
    expect(calls.some((c) => c.argv[0] === 'npm ci')).toBe(true);
  });

  it('D2: the worktree list read asks for raw output, so a long ticket id or a UUID-bearing path never gets redacted mid-parse', async () => {
    const calls: RunRequest[] = [];
    const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
    const exec = async (request: RunRequest): Promise<RunResult> => {
      calls.push(request);
      if (request.argv.includes('list')) {
        return listResult(`worktree ${worktreePath}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
      }
      return { ok: true, tail: '' } as RunResult;
    };

    await provisionWorktree({ chainEnv, repo, ticket, exec, fs: fakeFs({ markerExists: true }) });

    const list = calls.find((c) => c.argv.includes('list'));
    expect(list?.raw).toBe(true);
  });

  it('existing path on the branch reuses and skips the add', async () => {
    const calls: RunRequest[] = [];
    const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
    const exec = async (request: RunRequest): Promise<RunResult> => {
      calls.push(request);
      if (request.argv.includes('list')) {
        return listResult(`worktree ${worktreePath}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
      }
      return { ok: true, tail: '' } as RunResult;
    };

    const result = await provisionWorktree({ chainEnv, repo, ticket, exec, fs: fakeFs({ markerExists: true }) });

    expect(result.reused).toBe(true);
    expect(calls.some((c) => c.argv.includes('add'))).toBe(false);
  });

  it('a branch checked out elsewhere blocks with that path in the reason', async () => {
    const elsewhere = worktreePathFor(checkout, 'owner/other', ticket);
    const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
    const exec = async (request: RunRequest): Promise<RunResult> => {
      if (request.argv.includes('list')) {
        return listResult(`worktree ${elsewhere}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
      }
      return { ok: true, tail: '' } as RunResult;
    };

    await expect(provisionWorktree({ chainEnv, repo, ticket, exec, fs: fakeFs() }))
      .rejects.toThrow(elsewhere);
  });

  it('setup is skipped on a reused worktree when the marker says it already completed', async () => {
    const calls: RunRequest[] = [];
    const chainEnv = envWith({
      checkouts: [{ repo, value: checkout }], worktreeSetup: [{ repo, value: 'npm ci' }],
    });
    const exec = async (request: RunRequest): Promise<RunResult> => {
      calls.push(request);
      if (request.argv.includes('list')) {
        return listResult(`worktree ${worktreePath}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
      }
      return { ok: true, tail: '' } as RunResult;
    };

    await provisionWorktree({ chainEnv, repo, ticket, exec, fs: fakeFs({ markerExists: true }) });

    expect(calls.some((c) => c.argv[0] === 'npm ci')).toBe(false);
  });

  it('setup runs on a reused worktree when the marker is missing (its last run did not complete)', async () => {
    const calls: RunRequest[] = [];
    const chainEnv = envWith({
      checkouts: [{ repo, value: checkout }], worktreeSetup: [{ repo, value: 'npm ci' }],
    });
    const exec = async (request: RunRequest): Promise<RunResult> => {
      calls.push(request);
      if (request.argv.includes('list')) {
        return listResult(`worktree ${worktreePath}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
      }
      return { ok: true, tail: '' } as RunResult;
    };

    const result = await provisionWorktree({ chainEnv, repo, ticket, exec, fs: fakeFs({ markerExists: false }) });

    expect(result.reused).toBe(true);
    expect(calls.some((c) => c.argv[0] === 'npm ci')).toBe(true);
  });

  describe('B.4: orphan worktree reclaim', () => {
    it('a live registry row owning the elsewhere path still blocks, same as with no registryRows at all', async () => {
      const elsewhere = worktreePathFor(checkout, 'owner/other', ticket);
      const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
      const exec = async (request: RunRequest): Promise<RunResult> => {
        if (request.argv.includes('list')) {
          return listResult(`worktree ${elsewhere}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
        }
        return { ok: true, tail: '' } as RunResult;
      };

      await expect(provisionWorktree({
        chainEnv, repo, ticket, exec, fs: fakeFs(),
        registryRows: () => [{ cwd: elsewhere, pid: 1 }],
        isAlive: () => true,
      })).rejects.toThrow(elsewhere);
    });

    it('no live registry row owning the elsewhere path reclaims it: removes, retries the add, and journals the reclaim', async () => {
      const elsewhere = worktreePathFor(checkout, 'owner/other', ticket);
      const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
      const calls: RunRequest[] = [];
      let listedOnce = false;
      const exec = async (request: RunRequest): Promise<RunResult> => {
        calls.push(request);
        if (request.argv.includes('list')) {
          if (!listedOnce) {
            listedOnce = true;
            return listResult(`worktree ${elsewhere}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
          }
          return listResult('');
        }
        return { ok: true, tail: '' } as RunResult;
      };
      let reclaimed: [string, string] | undefined;

      const result = await provisionWorktree({
        chainEnv, repo, ticket, exec, fs: fakeFs(),
        registryRows: () => [{ cwd: '/somewhere/else', pid: 1 }],
        isAlive: () => true,
        onReclaim: (worktreePath, reclaimedBranch) => { reclaimed = [worktreePath, reclaimedBranch]; },
      });

      expect(result.worktreePath).toBe(worktreePath);
      expect(reclaimed).toEqual([elsewhere, branch]);
      const remove = calls.find((c) => c.argv.includes('remove'));
      expect(remove?.argv).toContain(elsewhere);
      const add = calls.find((c) => c.argv.includes('add'));
      expect(add?.argv).toContain(worktreePath);
    });

    it('a registry row owning the elsewhere path but whose pid is dead still reclaims it', async () => {
      const elsewhere = worktreePathFor(checkout, 'owner/other', ticket);
      const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
      const exec = async (request: RunRequest): Promise<RunResult> => {
        if (request.argv.includes('list')) {
          return listResult(`worktree ${elsewhere}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
        }
        return { ok: true, tail: '' } as RunResult;
      };

      const result = await provisionWorktree({
        chainEnv, repo, ticket, exec, fs: fakeFs(),
        registryRows: () => [{ cwd: elsewhere, pid: 999_999 }],
        isAlive: () => false,
      });

      expect(result.worktreePath).toBe(worktreePath);
    });

    it('a failed reclaim still blocks, naming both the original conflict and the remove failure', async () => {
      const elsewhere = worktreePathFor(checkout, 'owner/other', ticket);
      const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
      const exec = async (request: RunRequest): Promise<RunResult> => {
        if (request.argv.includes('list')) {
          return listResult(`worktree ${elsewhere}\nHEAD abcdef\nbranch refs/heads/${branch}\n`);
        }
        if (request.argv.includes('remove')) return { ok: false, tail: 'worktree has modified or untracked files' } as RunResult;
        return { ok: true, tail: '' } as RunResult;
      };

      await expect(provisionWorktree({
        chainEnv, repo, ticket, exec, fs: fakeFs(),
        registryRows: () => [],
        isAlive: () => true,
      })).rejects.toThrow(/modified or untracked files/);
    });
  });

  describe('B.7: main-checkout guard', () => {
    it('refuses a checkout resolving to a configured main checkout when the lock is not held', async () => {
      const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
      process.env['FORGE_MAIN_CHECKOUTS'] = `${checkout}=main-checkout-fake`;
      try {
        await expect(provisionWorktree({
          chainEnv, repo, ticket, fs: fakeFs(), hasLock: () => false,
        })).rejects.toThrow(/main-checkout-fake/);
      } finally {
        delete process.env['FORGE_MAIN_CHECKOUTS'];
      }
    });

    it('proceeds when the configured lock is held', async () => {
      const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
      const exec = async (request: RunRequest): Promise<RunResult> => {
        if (request.argv.includes('list')) return listResult('');
        return { ok: true, tail: '' } as RunResult;
      };
      process.env['FORGE_MAIN_CHECKOUTS'] = `${checkout}=main-checkout-fake`;
      try {
        const result = await provisionWorktree({
          chainEnv, repo, ticket, exec, fs: fakeFs(), hasLock: (name) => name === 'main-checkout-fake',
        });
        expect(result.worktreePath).toBe(worktreePath);
      } finally {
        delete process.env['FORGE_MAIN_CHECKOUTS'];
      }
    });

    it('with no hasLock at all, an otherwise-configured main checkout runs unguarded (opt-in only)', async () => {
      const chainEnv = envWith({ checkouts: [{ repo, value: checkout }] });
      const exec = async (request: RunRequest): Promise<RunResult> => {
        if (request.argv.includes('list')) return listResult('');
        return { ok: true, tail: '' } as RunResult;
      };
      process.env['FORGE_MAIN_CHECKOUTS'] = `${checkout}=main-checkout-fake`;
      try {
        const result = await provisionWorktree({ chainEnv, repo, ticket, exec, fs: fakeFs() });
        expect(result.worktreePath).toBe(worktreePath);
      } finally {
        delete process.env['FORGE_MAIN_CHECKOUTS'];
      }
    });

  });
});

describe('B.8: runWorktreeSetup serializes per repo', () => {
  it('two concurrent setups for the same repo never overlap', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let sawOverlap = false;
    const chainEnv = envWith({ worktreeSetup: [{ repo: 'owner/name', value: 'npm ci' }] });
    const exec = async (): Promise<RunResult> => {
      inFlight += 1;
      if (inFlight > 1) sawOverlap = true;
      order.push('start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('end');
      inFlight -= 1;
      return { ok: true, tail: '' } as RunResult;
    };

    await Promise.all([
      runWorktreeSetup({ chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/wt1', exec }),
      runWorktreeSetup({ chainEnv, repo: 'owner/name', ticket: 'ABC-2', worktreePath: 'C:/wt2', exec }),
    ]);

    expect(sawOverlap).toBe(false);
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });

  it('setups for different repos are never serialized against each other', async () => {
    let bothInFlightAtOnce = false;
    let aStarted = false;
    let bStarted = false;
    const chainEnv = envWith({
      worktreeSetup: [{ repo: 'owner/a', value: 'npm ci' }, { repo: 'owner/b', value: 'npm ci' }],
    });
    const execA = async (): Promise<RunResult> => {
      aStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (bStarted) bothInFlightAtOnce = true;
      return { ok: true, tail: '' } as RunResult;
    };
    const execB = async (): Promise<RunResult> => {
      bStarted = true;
      if (aStarted) bothInFlightAtOnce = true;
      return { ok: true, tail: '' } as RunResult;
    };

    await Promise.all([
      runWorktreeSetup({ chainEnv, repo: 'owner/a', ticket: 'ABC-1', worktreePath: 'C:/wt1', exec: execA }),
      runWorktreeSetup({ chainEnv, repo: 'owner/b', ticket: 'ABC-2', worktreePath: 'C:/wt2', exec: execB }),
    ]);

    expect(bothInFlightAtOnce).toBe(true);
  });

  it('a failed setup for one ticket does not block the next ticket on the same repo', async () => {
    const chainEnv = envWith({ worktreeSetup: [{ repo: 'owner/name', value: 'npm ci' }] });
    const failing = async (): Promise<RunResult> => ({ ok: false, tail: 'boom' } as RunResult);
    const succeeding = async (): Promise<RunResult> => ({ ok: true, tail: '' } as RunResult);

    await expect(runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-1', worktreePath: 'C:/wt1', exec: failing,
    })).rejects.toThrow(/boom/);

    await expect(runWorktreeSetup({
      chainEnv, repo: 'owner/name', ticket: 'ABC-2', worktreePath: 'C:/wt2', exec: succeeding,
    })).resolves.toBeUndefined();
  });
});

/** E1: the argv a chain launch spawns, against the parent's own `execArgv`/`argv[1]`. */
describe('chainLaunchArgv', () => {
  it('is execArgv, argv[1], run, the brief path, and the condition -- in that order', () => {
    const argv = chainLaunchArgv(['--loader', 'tsx'], '/repo/src/forge/cli.ts', 'C:/briefs/p1.md');
    expect(argv).toEqual(['--loader', 'tsx', '/repo/src/forge/cli.ts', 'run', 'C:/briefs/p1.md', CHAIN_LAUNCH_CONDITION]);
  });

  it('never touches import.meta.url or a cli.js sibling', () => {
    const argv = chainLaunchArgv([], '/repo/dist/forge/cli.js', 'C:/briefs/p1.md');
    expect(argv).not.toContain(expect.stringMatching(/chain-wire/));
    expect(argv[0]).toBe('/repo/dist/forge/cli.js');
  });
});

/** 2026-09-08: the argv a goal item's launch spawns -- the block as the second
 *  argument, never the goal path's own file contents, and `--goal` naming which one
 *  it is. */
describe('chainLaunchGoalArgv', () => {
  it('is execArgv, argv[1], run, the goal path, the block, --goal, then --run-key -- in that order', () => {
    const argv = chainLaunchGoalArgv(
      ['--loader', 'tsx'], '/repo/src/forge/cli.ts', 'C:/goals/g1.md', '/goal do the thing', 'g1-Q-abc123',
    );
    expect(argv).toEqual([
      '--loader', 'tsx', '/repo/src/forge/cli.ts', 'run', 'C:/goals/g1.md', '/goal do the thing',
      '--goal', '--run-key', 'g1-Q-abc123',
    ]);
  });

  it('carries the block as one argv entry even when it has spaces, never split', () => {
    const argv = chainLaunchGoalArgv([], '/repo/dist/forge/cli.js', 'C:/goals/g1.md', '/goal a b c', 'g1-Q-1');
    expect(argv).toEqual(['/repo/dist/forge/cli.js', 'run', 'C:/goals/g1.md', '/goal a b c', '--goal', '--run-key', 'g1-Q-1']);
  });

  it('2026-09-08: carries the caller-supplied run key rather than the bare goal-path basename, so two queue items off the same file never collide', () => {
    const argv = chainLaunchGoalArgv([], '/repo/cli.js', 'C:/goals/same-file.md', '/goal x', 'same-file-Q-first');
    expect(argv).toContain('same-file-Q-first');
    const argvSecond = chainLaunchGoalArgv([], '/repo/cli.js', 'C:/goals/same-file.md', '/goal x', 'same-file-Q-second');
    expect(argvSecond).toContain('same-file-Q-second');
    expect(argv).not.toEqual(argvSecond);
  });
});

/** E2/E3: whether a run has actually started, off an injected registry and journal events. */
describe('hasRunRegistered', () => {
  function registryReturning(row: unknown): Pick<Registry, 'get'> {
    return { get: () => row as ReturnType<Registry['get']> };
  }

  it('true when the registry has a row for the run key', () => {
    const registered = hasRunRegistered('abc-1', {
      registry: registryReturning({ goal: 'abc-1' }), events: [],
    });
    expect(registered).toBe(true);
  });

  it('true when a run.started row names the run key, with no registry row', () => {
    const registered = hasRunRegistered('abc-1', {
      registry: registryReturning(undefined),
      events: [{ event: 'run.started', run: 'abc-1' }],
    });
    expect(registered).toBe(true);
  });

  it('false when neither the registry nor the journal has anything for the run key', () => {
    const registered = hasRunRegistered('abc-1', {
      registry: registryReturning(undefined),
      events: [{ event: 'run.started', run: 'some-other-run' }],
    });
    expect(registered).toBe(false);
  });
});

/** E2: the wait loop, against an injected clock, registry, child, and log. */
describe('waitForLaunchToRegister', () => {
  function fakeClock(startMs = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let current = startMs;
    return {
      now: () => current,
      sleep: async (ms: number) => { current += ms; },
    };
  }

  it('resolves as soon as the run registers, without waiting out the full budget', async () => {
    const clock = fakeClock();
    let calls = 0;
    const registry: Pick<Registry, 'get'> = {
      get: () => {
        calls += 1;
        return (calls >= 2 ? { goal: 'abc-1' } : undefined) as ReturnType<Registry['get']>;
      },
    };

    await waitForLaunchToRegister({
      runKey: 'abc-1',
      registry,
      readEvents: () => [],
      child: { exitCode: null },
      readLogTail: () => '',
      waitMs: 45_000,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 200,
    });

    expect(clock.now()).toBeLessThan(45_000);
  });

  it('throws with the exit code and the log tail once the child exits before registering', async () => {
    const clock = fakeClock();
    const registry: Pick<Registry, 'get'> = { get: () => undefined };

    await expect(waitForLaunchToRegister({
      runKey: 'abc-1',
      registry,
      readEvents: () => [],
      child: { exitCode: 1 },
      readLogTail: () => 'Error: cannot find module cli.js',
      waitMs: 45_000,
      now: clock.now,
      sleep: clock.sleep,
    })).rejects.toThrow(/exited with code 1/);

    await expect(waitForLaunchToRegister({
      runKey: 'abc-1',
      registry,
      readEvents: () => [],
      child: { exitCode: 1 },
      readLogTail: () => 'Error: cannot find module cli.js',
      waitMs: 45_000,
      now: clock.now,
      sleep: clock.sleep,
    })).rejects.toThrow(/cannot find module cli\.js/);
  });

  it('throws once the wait itself runs out, carrying the log tail, for a child still running', async () => {
    const clock = fakeClock();
    const registry: Pick<Registry, 'get'> = { get: () => undefined };

    await expect(waitForLaunchToRegister({
      runKey: 'abc-1',
      registry,
      readEvents: () => [],
      child: { exitCode: null },
      readLogTail: () => 'still starting up',
      waitMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 250,
    })).rejects.toThrow(/did not register within/);
  });

  it('the thrown message never carries more than the last 300 characters of the log', async () => {
    const clock = fakeClock();
    const registry: Pick<Registry, 'get'> = { get: () => undefined };
    const longLog = 'x'.repeat(1000);

    await expect(waitForLaunchToRegister({
      runKey: 'abc-1',
      registry,
      readEvents: () => [],
      child: { exitCode: 1 },
      readLogTail: () => longLog,
      waitMs: 45_000,
      now: clock.now,
      sleep: clock.sleep,
    })).rejects.toThrow(new RegExp(`x{300}(?!x)`));
  });
});

/** E1: `FORGE_CHAIN_LAUNCH_WAIT_S`, in milliseconds. */
describe('launchWaitMs', () => {
  it('defaults to 45s when unset', () => {
    expect(launchWaitMs({})).toBe(45_000);
  });

  it('reads a configured value, converted to milliseconds', () => {
    expect(launchWaitMs({ FORGE_CHAIN_LAUNCH_WAIT_S: '10' })).toBe(10_000);
  });

  it('falls back to 45s on a non-positive or unparsable value', () => {
    expect(launchWaitMs({ FORGE_CHAIN_LAUNCH_WAIT_S: '0' })).toBe(45_000);
    expect(launchWaitMs({ FORGE_CHAIN_LAUNCH_WAIT_S: 'nope' })).toBe(45_000);
  });
});

describe('runOutcome', () => {
  it('unknown run key: not finished', () => {
    expect(runOutcome('abc-1', { runs: {}, events: [] })).toEqual({ finished: false });
  });

  it('a root still started, no successor: not finished', () => {
    const runs = { 'abc-1': { state: 'started' } };
    expect(runOutcome('abc-1', { runs, events: [] })).toEqual({ finished: false });
  });

  it('a root finished done: finished with that verdict', () => {
    const runs = { 'abc-1': { state: 'finished', verdict: 'done' } };
    expect(runOutcome('abc-1', { runs, events: [] })).toEqual({ finished: true, verdict: 'done' });
  });

  it('a finished root with no verdict on the fold reads it off its run.finished row', () => {
    const runs = { 'abc-1': { state: 'finished' } };
    const events = [{ event: 'run.finished', run: 'abc-1', verdict: 'exhausted' }];
    expect(runOutcome('abc-1', { runs, events })).toEqual({ finished: true, verdict: 'exhausted' });
  });

  it('two handoffs then done: the verdict is the last successor\'s, not unknown', () => {
    const runs = {
      'abc-1': { state: 'handed-off', successor: 'abc-1-2' },
      'abc-1-2': { state: 'handed-off', successor: 'abc-1-3' },
      'abc-1-3': { state: 'finished', verdict: 'done' },
    };
    expect(runOutcome('abc-1', { runs, events: [] })).toEqual({ finished: true, verdict: 'done' });
  });

  it('a handed-off root whose successor is still working: not finished', () => {
    const runs = {
      'abc-1': { state: 'handed-off', successor: 'abc-1-2' },
      'abc-1-2': { state: 'started' },
    };
    expect(runOutcome('abc-1', { runs, events: [] })).toEqual({ finished: false });
  });

  it('a root put back to started by a resume, with a successor that finished: the successor decides', () => {
    const runs = {
      'abc-1': { state: 'started', successor: 'abc-1-2' },
      'abc-1-2': { state: 'finished', verdict: 'done' },
    };
    expect(runOutcome('abc-1', { runs, events: [] })).toEqual({ finished: true, verdict: 'done' });
  });

  it('a handoff whose successor has not folded yet: not finished', () => {
    const runs = { 'abc-1': { state: 'handed-off', successor: 'abc-1-2' } };
    expect(runOutcome('abc-1', { runs, events: [] })).toEqual({ finished: false });
  });

  it('a parked terminal run: finished, and the verdict says parked rather than nothing', () => {
    const runs = {
      'abc-1': { state: 'handed-off', successor: 'abc-1-2' },
      'abc-1-2': { state: 'parked' },
    };
    expect(runOutcome('abc-1', { runs, events: [] })).toEqual({ finished: true, verdict: 'parked' });
  });

  it('a successor cycle terminates instead of looping', () => {
    const runs = {
      'abc-1': { state: 'handed-off', successor: 'abc-1-2' },
      'abc-1-2': { state: 'handed-off', successor: 'abc-1' },
    };
    expect(runOutcome('abc-1', { runs, events: [] }).finished).toBe(false);
  });
});
