/**
 * Wires `CodeSyncDeps` to real git and gh, exactly as `self-wire.ts:114-126` builds
 * `git` on `execRun` -- never executed against a repo in a test, per the guardrail.
 * Covered only by an argv-shape test.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseFor, readChainEnv } from '../../chain-env.js';
import { run as defaultExecRun, type RunRequest, type RunResult } from '../../exec.js';
import { workspaceRoot } from '../../paths.js';
import { worktreeStatusForAsync } from '../../sessions/cleanup.js';
import type { CodeSyncDeps } from './index.js';

const CLAIM_FRESH_MS = 10 * 60 * 1000;

export interface BuildCodeSyncDepsOptions {
  execRun?: (request: RunRequest) => Promise<RunResult>;
  sessionsDir?: string;
}

interface SessionClaim {
  path?: string;
}

interface SessionRecord {
  heartbeatAt?: number;
  claims?: SessionClaim[];
}

function defaultSessionsDir(): string {
  return join(workspaceRoot(), '.claude', 'coordination', 'sessions');
}

function readClaimedPaths(sessionsDir: string, nowMs: number): string[] {
  if (!existsSync(sessionsDir)) return [];
  const paths: string[] = [];
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith('.json')) continue;
    let record: SessionRecord;
    try {
      record = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8')) as SessionRecord;
    } catch {
      continue;
    }
    const heartbeatAt = record.heartbeatAt ?? 0;
    const ageMs = nowMs - heartbeatAt * 1000;
    if (ageMs > CLAIM_FRESH_MS) continue;
    for (const claim of record.claims ?? []) {
      if (claim.path) paths.push(claim.path);
    }
  }
  return paths;
}

export function buildCodeSyncDeps(
  env: NodeJS.ProcessEnv = process.env,
  opts: BuildCodeSyncDepsOptions = {},
): CodeSyncDeps {
  const execRun = opts.execRun ?? defaultExecRun;
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
  const chainEnv = readChainEnv(env);

  async function git(checkout: string, argv: string[]): Promise<string> {
    const result = await execRun({
      argv: ['git', ...argv], cwd: checkout, owner: 'sync-code', cls: 'script',
      raw: true, fullOutput: true, wall: 60,
    });
    if (!result.ok) throw new Error(`git ${argv[0]} failed: ${(result.full ?? result.tail).trim().slice(0, 200)}`);
    return (result.full ?? result.tail).trim();
  }

  async function gh(argv: string[], cwd?: string): Promise<string> {
    const result = await execRun({
      argv: ['gh', ...argv], cwd: cwd ?? process.cwd(), owner: 'sync-code', cls: 'script',
      raw: true, fullOutput: true, wall: 60,
    });
    if (!result.ok) throw new Error(`gh ${argv[0]} failed: ${(result.full ?? result.tail).trim().slice(0, 200)}`);
    return (result.full ?? result.tail).trim();
  }

  const repos = chainEnv.checkouts.map(({ repo, value }) => ({
    repo, checkout: value, base: baseFor(chainEnv, repo),
  }));

  return {
    git,
    gh,
    repos,
    claimedPaths: () => readClaimedPaths(sessionsDir, Date.now()),
    worktreeStatus: (path) => worktreeStatusForAsync('sync-code', path, execRun),
    now: () => Date.now(),
  };
}
