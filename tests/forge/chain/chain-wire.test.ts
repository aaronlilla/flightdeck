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

import { readChainEnv, type ChainEnv } from '../../../src/forge/chain-env.js';
import { runWorktreeSetup } from '../../../src/forge/chain-wire.js';
import type { RunRequest, RunResult } from '../../../src/forge/exec.js';

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
