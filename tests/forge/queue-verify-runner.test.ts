import { describe, expect, it, vi } from 'vitest';

import { queueRunRepoVerify } from '../../src/forge/queue-wire.js';
import type { ChainEnv } from '../../src/forge/chain-env.js';

/**
 * How the gate runs a repository's own verify.
 *
 * The command is a sentence a person wrote into `FORGE_REPO_VERIFY` -- one npm script, or
 * several joined by `&&`. Handing that to a direct exec looks for a program whose name is
 * the whole line, so it must go through a shell, the same way the worktree setup command
 * already does.
 *
 * Written after the first cut did exactly that and the gate's verify never ran (2026-09-12).
 */
function env(overrides: Partial<ChainEnv> = {}): ChainEnv {
  return {
    enabled: true, pollSeconds: 30, checkouts: [], bases: [], worktreeSetup: [],
    verify: [{ repo: 'owner/name', value: 'npm run verify' }],
    mergeRepos: [], forceCodex: false, shell: [], repoKinds: [],
    ...overrides,
  } as ChainEnv;
}

describe('the verify the gate stands in for missing checks', () => {
  it('runs the command through a shell rather than exec\'ing the whole line', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const exec = vi.fn(async (request: Record<string, unknown>) => {
      calls.push(request);
      return { returncode: 0, full: 'ok', tail: 'ok' };
    });
    const run = queueRunRepoVerify(env(), exec as never);
    const result = await run({ repo: 'owner/name', worktreePath: '/tmp/tree' });

    expect(result.ok).toBe(true);
    expect(calls[0]?.['argv'], 'the command was split into arguments').toEqual(['npm run verify']);
    expect(calls[0]?.['shell'], 'it was exec\'d directly, so the command name is the whole line').toBeTruthy();
    expect(calls[0]?.['cwd']).toBe('/tmp/tree');
  });

  it('uses the configured shell prefix when there is one', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const exec = vi.fn(async (request: Record<string, unknown>) => {
      calls.push(request);
      return { returncode: 0, full: '', tail: '' };
    });
    const run = queueRunRepoVerify(env({ shell: ['bash', '-lc'] }), exec as never);
    await run({ repo: 'owner/name', worktreePath: '/tmp/tree' });
    expect(calls[0]?.['shell']).toEqual(['bash', '-lc']);
  });

  it('reports a non-zero exit as a failure, with the output', async () => {
    const exec = vi.fn(async () => ({ returncode: 1, full: 'two failed', tail: 'two failed' }));
    const run = queueRunRepoVerify(env(), exec as never);
    expect(await run({ repo: 'owner/name', worktreePath: '/tmp/tree' }))
      .toEqual({ ok: false, output: 'two failed' });
  });

  it('says so rather than running nothing when a repository has no command', async () => {
    const exec = vi.fn(async () => ({ returncode: 0, full: '', tail: '' }));
    const run = queueRunRepoVerify(env({ verify: [] }), exec as never);
    const result = await run({ repo: 'owner/name', worktreePath: '/tmp/tree' });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no FORGE_REPO_VERIFY command is configured/);
    expect(exec, 'it ran something anyway').not.toHaveBeenCalled();
  });
});
