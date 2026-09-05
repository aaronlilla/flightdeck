/**
 * Production wiring for the chain in `chain.ts`. Nothing in `chain.ts` itself ever
 * touches the network or spawns a process -- every real git command, `gh` call, and
 * worker launch lives here instead, so a specimen never needs any of it and this module
 * carries no specimens of its own beyond its handful of pure helpers.
 *
 * `forge up` builds one `ChainDeps` from here when `FORGE_CHAIN=1`, and nothing else in
 * this codebase constructs one.
 */
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { CliResult, ForgeDeps } from './cli.js';
import { forge } from './cli.js';
import {
  completeBriefWithVerification,
  type ChainCouncilFn, type ChainDeps, type ChainGateFn, type ChainGh, type ChainLauncher, type ChainPlannedPacket,
} from './chain.js';
import {
  baseFor, checkoutFor, mergeAllowedFor, verifyCommandFor, worktreePathFor, worktreeSetupFor,
  branchFor, type ChainEnv,
} from './chain-env.js';
import type { PollSourceName } from './contracts.js';
import { run as execRun, type RunRequest, type RunResult } from './exec.js';
import { createJiraFeed } from './intake/jira.js';
import { intakeBriefsDir, journalPath, killSwitchPath, forgeHome } from './paths.js';
import { readWatermark, writeWatermark } from './intake/watermarkStore.js';
import { planFromPacket } from './intake/planner.js';
import { runIntakeOnce } from './intake/once.js';
import { parseRepoMap } from './intake/repoRoute.js';
import { resolvePlanProvider } from './intake/reasoner.js';
import { loadPolicy } from './policy.js';
import { reasonerFor } from './reasoner-claude.js';
import { Journal, replay } from './journal.js';
import { readKillSwitch } from './supervisor.js';

const JIRA_ENV_VARS = ['FORGE_JIRA_SITE', 'FORGE_JIRA_EMAIL', 'FORGE_JIRA_TOKEN'] as const;

/**
 * H1: the same pipeline `forge intake --once` runs, minus the CLI's own
 * printing -- one poll of every configured feed, then one planner call per packet the
 * poll wrote (every packet, not only the first: the CLI's own "best-effort, one packet"
 * note is a printing simplification, not a limit the chain needs to keep).
 */
export function chainIntake(): () => Promise<ChainPlannedPacket[]> {
  return async () => {
    const missing = JIRA_ENV_VARS.filter((name) => !process.env[name]);
    const feeds = missing.length
      ? []
      : [createJiraFeed({
          site: process.env['FORGE_JIRA_SITE']!, email: process.env['FORGE_JIRA_EMAIL']!,
          token: process.env['FORGE_JIRA_TOKEN']!, jql: process.env['FORGE_JIRA_JQL'],
        })];

    const journal = new Journal(journalPath());
    try {
      const result = await runIntakeOnce(
        feeds,
        { get: (source: PollSourceName) => readWatermark(source), set: (source, mark) => writeWatermark(source, mark) },
        (event) => journal.append({ actor: 'intake', ...event }),
        undefined,
        parseRepoMap(process.env['FORGE_INTAKE_REPO_MAP']),
      );

      const planned: ChainPlannedPacket[] = [];
      if (!result.writtenPackets.length) return planned;

      const provider = resolvePlanProvider(loadPolicy().reasoner);
      const reasoner = reasonerFor(provider, { journal });
      const briefsDir = intakeBriefsDir();
      mkdirSync(briefsDir, { recursive: true });

      for (const packet of result.writtenPackets) {
        const plannedBrief = await planFromPacket(packet, reasoner);
        const briefPath = join(briefsDir, `${plannedBrief.packetId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
        writeFileSync(briefPath, plannedBrief.text, 'utf8');
        planned.push({
          packetId: plannedBrief.packetId, ticket: plannedBrief.ticket, repo: packet.repo, briefPath,
        });
      }
      return planned;
    } finally {
      journal.close();
    }
  };
}

const WORKER_ENV_STRIP = [
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'ANTHROPIC_API_KEY',
] as const;

function tailOfCommand(tail: string, limit = 500): string {
  return tail.length > limit ? tail.slice(-limit) : tail;
}

/**
 * C1: the worktree setup command, run through a shell rather than exec'd directly.
 * `FORGE_REPO_CHECKOUTS`'s worktree add never needed a shell -- one binary, one argv --
 * but the setup command is whatever a repository's own bootstrap needs, commonly more
 * than one step joined with `&&`, and on Windows `npm` is a `.cmd` shim a direct exec
 * never finds. `FORGE_WORKTREE_SHELL` names a shell prefix (a bash path plus `-c`,
 * say); left unset, the command runs under the platform's own default shell instead.
 * Split out from `provision()` so a specimen can prove this step alone, against an
 * injected `exec`, without a real git checkout underneath it.
 */
export async function runWorktreeSetup(input: {
  chainEnv: ChainEnv; repo: string; ticket: string; worktreePath: string;
  exec?: (request: RunRequest) => Promise<RunResult>;
}): Promise<void> {
  const setup = worktreeSetupFor(input.chainEnv, input.repo);
  if (!setup) return;

  const runner = input.exec ?? execRun;
  const result = await runner({
    argv: [setup],
    shell: input.chainEnv.shell.length ? input.chainEnv.shell : true,
    cwd: input.worktreePath, owner: `chain-${input.ticket}`, cls: 'install',
  });
  if (!result.ok) {
    throw new Error(`setup command failed: ${setup}\n${tailOfCommand(result.tail, 300)}`);
  }
}

/**
 * D1, 2026-09-05: a worktree already on disk, on the packet's own branch, is a thing to
 * reuse rather than a fresh `git worktree add` to attempt. The old check leaned on
 * `git worktree add` refusing and the string `already exists` showing up in its output --
 * which is exactly the shape that broke on the live run this fixes: a retry after a
 * failed `worktreeSetup` ran `add` again for a worktree the first attempt had already
 * created, and it wasn't a `chain.provisioned` row (only written after setup succeeds)
 * that would have told this hop to skip the add, it was git's own error text. This reads
 * `git worktree list` first instead, so the decision is made from what git says exists
 * right now, never from a journal row that setup failing left unwritten.
 */
export interface WorktreeListEntry {
  path: string;
  branch?: string;
}

/** `git worktree list --porcelain` is entries separated by a blank line, each carrying a
 *  `worktree <path>` line and (for anything but a detached checkout) a `branch
 *  refs/heads/<name>` line. */
export function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === '') {
      current = undefined;
    }
  }
  return entries;
}

function normalizeWorktreePath(worktreePath: string): string {
  return worktreePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export interface ProvisionFs {
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  statSync: typeof statSync;
  mkdirSync: typeof mkdirSync;
}

const REAL_FS: ProvisionFs = {
  existsSync, readFileSync, writeFileSync, statSync, mkdirSync,
};

const SETUP_DONE_MARKER = 'forge-chain-setup-done';

/**
 * A linked worktree's `.git` is a file naming its real metadata directory (`gitdir:
 * <path>`), not a directory of its own -- the marker lives there, never inside the
 * worktree's own tracked tree, so a specimen swapping worktrees never finds it staged.
 * Falls back to `<worktreePath>/.git` itself on anything unexpected (a plain directory,
 * or a fake filesystem a specimen never bothered to shape as a real linked worktree).
 */
function gitMetaDir(worktreePath: string, fs: ProvisionFs): string {
  const dotGit = join(worktreePath, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return dotGit;
  }
  try {
    const content = fs.readFileSync(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
    if (match?.[1]) return match[1].trim();
  } catch {
    // fall through to the plain path below
  }
  return dotGit;
}

function setupMarkerPath(worktreePath: string, fs: ProvisionFs): string {
  return join(gitMetaDir(worktreePath, fs), SETUP_DONE_MARKER);
}

function setupAlreadyDone(worktreePath: string, fs: ProvisionFs): boolean {
  try {
    return fs.existsSync(setupMarkerPath(worktreePath, fs));
  } catch {
    return false;
  }
}

function markSetupDone(worktreePath: string, fs: ProvisionFs): void {
  fs.writeFileSync(setupMarkerPath(worktreePath, fs), '', 'utf8');
}

export interface ProvisionResult {
  worktreePath: string;
  branch: string;
  base: string;
  /** True when an existing worktree on the expected branch was reused rather than
   *  created fresh -- carried onto the `chain.provisioned` journal row. */
  reused: boolean;
}

/** D1: the reuse decision itself, plus the real `git worktree add`/setup when there is
 *  nothing to reuse. Takes `exec` and `fs` as parameters the same way `runWorktreeSetup`
 *  does, so a specimen proves every branch (fresh path, existing path on the branch,
 *  branch checked out elsewhere, setup already marked done) against fakes rather than a
 *  real git checkout. */
export async function provisionWorktree(input: {
  chainEnv: ChainEnv; repo: string; ticket: string;
  exec?: (request: RunRequest) => Promise<RunResult>;
  fs?: ProvisionFs;
}): Promise<ProvisionResult> {
  const checkout = checkoutFor(input.chainEnv, input.repo);
  if (!checkout) throw new Error(`no FORGE_REPO_CHECKOUTS entry for ${input.repo}`);
  const base = baseFor(input.chainEnv, input.repo);
  const worktreePath = worktreePathFor(checkout, input.repo, input.ticket);
  const branch = branchFor(input.ticket);

  const runner = input.exec ?? execRun;
  const fs = input.fs ?? REAL_FS;

  const list = await runner({
    argv: ['git', '-C', checkout, 'worktree', 'list', '--porcelain'],
    cwd: checkout, owner: `chain-${input.ticket}`, cls: 'script',
  });
  const entries = list.ok ? parseWorktreeList(list.tail) : [];

  const target = normalizeWorktreePath(worktreePath);
  const samePath = entries.find((entry) => normalizeWorktreePath(entry.path) === target);
  const branchElsewhere = entries.find(
    (entry) => entry.branch === branch && normalizeWorktreePath(entry.path) !== target,
  );

  let reused = false;
  if (samePath && samePath.branch === branch) {
    reused = true;
  } else if (branchElsewhere) {
    throw new Error(`branch ${branch} is already checked out at ${branchElsewhere.path}`);
  } else {
    fs.mkdirSync(dirname(worktreePath), { recursive: true });
    const add = await runner({
      argv: ['git', '-C', checkout, 'worktree', 'add', '-B', branch, worktreePath, `origin/${base}`],
      cwd: checkout, owner: `chain-${input.ticket}`, cls: 'script',
    });
    if (!add.ok) throw new Error(tailOfCommand(add.tail));
  }

  if (!reused || !setupAlreadyDone(worktreePath, fs)) {
    await runWorktreeSetup({
      chainEnv: input.chainEnv, repo: input.repo, ticket: input.ticket, worktreePath, exec: input.exec,
    });
    markSetupDone(worktreePath, fs);
  }

  return { worktreePath, branch, base, reused };
}

/** H2/H3: real worktrees, a real detached launch, and a real status read off the shared
 *  journal -- one `ChainLauncher` per `chain-env.ts` configuration, built fresh on every
 *  `forge up` process. */
export function chainLauncher(chainEnv: ChainEnv, fleetConfigDir: string): ChainLauncher {
  return {
    async provision({ ticket, repo }) {
      return provisionWorktree({ chainEnv, repo, ticket });
    },

    async launch({ ticket, repo, briefPath, worktreePath, branch }) {
      const runKey = ticket.toLowerCase();

      const brief = readFileSync(briefPath, 'utf8');
      const completed = completeBriefWithVerification(brief, {
        ticket, repo, branch, base: baseFor(chainEnv, repo), verifyCommand: verifyCommandFor(chainEnv, repo),
      });
      if (completed !== brief) writeFileSync(briefPath, completed, 'utf8');

      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of WORKER_ENV_STRIP) delete env[name];
      env['CLAUDE_CONFIG_DIR'] = fleetConfigDir;
      env['FORGE_HOME'] = forgeHome();

      const cliEntry = join(dirname(new URL(import.meta.url).pathname), 'cli.js');
      const child = spawn(process.execPath, [cliEntry, 'run', briefPath], {
        cwd: worktreePath, env, detached: true, stdio: 'ignore',
      });
      child.unref();

      return { runKey };
    },

    async status(runKey) {
      const state = replay(journalPath());
      const run = state.runs[runKey];
      if (!run || run.state === 'started') return { finished: false };
      const finishedEvent = [...state.events].reverse()
        .find((event) => event.event === 'run.finished' && event.run === runKey);
      return {
        finished: true,
        verdict: run.verdict ?? (finishedEvent?.['verdict'] as string | undefined),
        // The journal carries no forge_done evidence text today (worker.ts's own gap,
        // named rather than papered over): the chain always falls back to `gh pr list`
        // for the PR itself.
      };
    },
  };
}

export function chainGh(): ChainGh {
  return {
    async findPrByHead(repo, branch) {
      const result = await execRun({
        argv: ['gh', 'pr', 'list', '--repo', repo, '--head', branch, '--json', 'number,url'],
        cwd: process.cwd(), owner: 'chain-gh', cls: 'script',
      });
      if (!result.ok) return undefined;
      try {
        const rows = JSON.parse(result.tail) as { number: number; url: string }[];
        return rows[0];
      } catch {
        return undefined;
      }
    },
  };
}

/** H4: reuses the already-tested `council`/`gate` CLI commands rather than a second copy
 *  of their logic -- `forge()`'s own `data` field (P5.7) is what lets a programmatic
 *  caller read the verdict and the merge outcome without parsing `lines`. */
export function chainCouncil(deps: ForgeDeps): ChainCouncilFn {
  return async ({ repo, pr, forceCodex, cwd, baseRef }) => {
    const result: CliResult = await forge(
      [
        'council', '--repo', repo, '--pr', String(pr),
        ...(cwd ? ['--cwd', cwd] : []),
        ...(baseRef ? ['--base', baseRef] : []),
      ],
      { ...deps, ...(forceCodex ? { forceCodexLane: true } : {}) },
    );
    const verdict = (result.data?.['verdict'] as string | undefined) ?? result.lines[0] ?? 'unavailable';
    return {
      verdict,
      ...(result.data?.['attestationPath'] ? { attestationPath: result.data['attestationPath'] as string } : {}),
    };
  };
}

export function chainGate(deps: ForgeDeps): ChainGateFn {
  return async ({ repo, pr, merge }) => {
    const result: CliResult = await forge(
      ['gate', '--repo', repo, '--pr', String(pr), ...(merge ? ['--merge'] : [])],
      deps,
    );
    return {
      merged: Boolean(result.data?.['merged']),
      ...(result.data?.['mergeSha'] ? { mergeSha: result.data['mergeSha'] as string } : {}),
    };
  };
}

export function buildChainDeps(chainEnv: ChainEnv, fleetConfigDir: string, deps: ForgeDeps): ChainDeps {
  return {
    intake: chainIntake(),
    launcher: chainLauncher(chainEnv, fleetConfigDir),
    gh: chainGh(),
    council: chainCouncil(deps),
    gate: chainGate(deps),
    clock: () => Date.now(),
    killSwitch: () => readKillSwitch(killSwitchPath()).engaged,
    mergeAllowed: (repo) => mergeAllowedFor(chainEnv, repo),
    append: (event) => {
      const journal = new Journal(journalPath());
      try {
        journal.append(event);
      } finally {
        journal.close();
      }
    },
  };
}
