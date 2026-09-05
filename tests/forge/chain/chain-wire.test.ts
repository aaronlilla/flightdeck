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
import { provisionWorktree, runWorktreeSetup, type ProvisionFs } from '../../../src/forge/chain-wire.js';
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
});
