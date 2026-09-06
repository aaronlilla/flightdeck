/**
 * Production wiring for the chain in `chain.ts`. Nothing in `chain.ts` itself ever
 * touches the network or spawns a process -- every real git command, `gh` call, and
 * worker launch lives here instead, so a specimen never needs any of it and this module
 * carries no specimens of its own beyond its handful of pure helpers.
 *
 * `forge up` builds one `ChainDeps` from here when `FORGE_CHAIN=1`, and nothing else in
 * this codebase constructs one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { CliResult, ForgeDeps } from './cli.js';
import { forge } from './cli.js';
import {
  completeBriefWithVerification, runKeyForBrief,
  type ChainCouncilFn, type ChainDeps, type ChainGateFn, type ChainGh, type ChainLauncher, type ChainPlannedPacket, type ChainRunStatus,
} from './chain.js';
import {
  baseFor, checkoutFor, mergeAllowedFor, verifyCommandFor, worktreePathFor, worktreeSetupFor,
  branchFor, type ChainEnv,
} from './chain-env.js';
import type { PollSourceName } from './contracts.js';
import { run as execRun, type RunRequest, type RunResult } from './exec.js';
import { createJiraFeed } from './intake/jira.js';
import {
  intakeBriefsDir, journalPath, killSwitchPath, forgeHome, registryDir, runDir,
} from './paths.js';
import { Registry } from './registry.js';
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
 * E1, 2026-09-05: the condition `forge run` gets for a chain launch. `forge run` falls
 * back to this exact text when nothing is passed, but a chain launch names it explicitly
 * instead of leaning on that default. That keeps the spawned argv complete on its own, so
 * a specimen can assert it without reaching into `cli.ts`'s fallback.
 */
export const CHAIN_LAUNCH_CONDITION = 'Work the brief to completion.';

/**
 * E1: the argv a chain launch spawns, built once so the production `launch()` and a
 * specimen asserting its shape read the same logic. `execArgv`/`argv1` are the parent's
 * own: `process.execArgv` and `process.argv[1]`, the entry script currently running
 * `forge up`, whether that is `src/forge/cli.ts` under tsx or `dist/forge/cli.js` under
 * node. Never derived from `import.meta.url`. That path carries a leading slash on
 * Windows and points at a `.js` sibling of `chain-wire.ts` that does not exist when the
 * parent itself is running from source under tsx.
 */
export function chainLaunchArgv(execArgv: readonly string[], argv1: string, briefPath: string): string[] {
  return [...execArgv, argv1, 'run', briefPath, CHAIN_LAUNCH_CONDITION];
}

/**
 * E2/E3: whether a run has actually started, read from the two places that would show
 * it: the registry row `forge run` admits before anything else, and the `run.started`
 * row the worker journals once it has a brief loaded. Either one is enough, and neither
 * is derived from the other, since a crash between admission and the worker's first
 * journal write leaves a registry row with no `run.started` row yet. E3's retry checks
 * both before deciding a launch never registered.
 */
export function hasRunRegistered(
  runKey: string, input: { registry: Pick<Registry, 'get'>; events: Iterable<Record<string, unknown>> },
): boolean {
  if (input.registry.get(runKey)) return true;
  for (const event of input.events) {
    if (event['event'] === 'run.started' && event['run'] === runKey) return true;
  }
  return false;
}

/** One run as the outcome reader sees it: its fold state, its verdict, and the successor
 *  a handoff named. Structural on purpose so a specimen hands in plain objects. */
export interface RunLink {
  state: string;
  verdict?: string;
  successor?: string;
}

/**
 * The outcome of the run under `runKey`, for the gate hop, read through its handoffs.
 *
 * A worker that reaches its context ceiling hands off (`run.handoff`, successor
 * `<key>-2`, then `-3`); the fold marks the root `handed-off` and the verdict lands on the
 * last successor's `run.finished`. The first live chain run handed off twice, so a read of
 * the root alone would have blocked the gate with `unknown` -- or, once a restart's
 * reconcile put the root back to `started`, waited on it forever. Follow `successor`
 * wherever the fold recorded one, whatever the state of the run that named it, and let
 * the last run in the line decide. A successor named but not yet folded is a run still
 * on its way, not a finish.
 */
export function runOutcome(
  runKey: string,
  input: { runs: Record<string, RunLink>; events: Iterable<Record<string, unknown>> },
): ChainRunStatus {
  const seen = new Set<string>();
  let key = runKey;
  let run = input.runs[key];
  while (run?.successor && !seen.has(key)) {
    seen.add(key);
    const next = input.runs[run.successor];
    if (!next) return { finished: false };
    key = run.successor;
    run = next;
  }
  if (!run) return { finished: false };
  if (run.state === 'started' || run.state === 'paused' || run.state === 'handed-off') {
    return { finished: false };
  }
  const finishedEvent = [...input.events].reverse()
    .find((event) => event['event'] === 'run.finished' && event['run'] === key);
  return {
    finished: true,
    verdict: run.verdict ?? (finishedEvent?.['verdict'] as string | undefined) ?? run.state,
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** `FORGE_CHAIN_LAUNCH_WAIT_S`, in milliseconds -- 45s when unset or not a positive number. */
export function launchWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['FORGE_CHAIN_LAUNCH_WAIT_S']);
  return (Number.isFinite(raw) && raw > 0 ? raw : 45) * 1000;
}

export interface LaunchWaitDeps {
  runKey: string;
  registry: Pick<Registry, 'get'>;
  /** Re-read fresh on every poll -- the journal grows while this waits. */
  readEvents: () => Iterable<Record<string, unknown>>;
  /** The spawned child; consulted for an exit code, never killed or written to. */
  child: Pick<ChildProcess, 'exitCode'>;
  readLogTail: () => string;
  waitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

/**
 * E2: waits up to `waitMs` for the run to register, polling `hasRunRegistered` on the
 * given interval, and resolves once it has. Throws once the child has exited without
 * ever registering, or once the wait itself runs out. Either way the message carries the
 * child's exit code (when it has one) and the last 300 characters of its launch log, so
 * the caller's own catch-and-journal (`chain.ts`'s `chain.blocked` on hop `launch`)
 * already has both without going looking for them.
 */
export async function waitForLaunchToRegister(deps: LaunchWaitDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const pollMs = deps.pollMs ?? 200;
  const deadline = now() + deps.waitMs;

  for (;;) {
    if (hasRunRegistered(deps.runKey, { registry: deps.registry, events: deps.readEvents() })) return;

    const { exitCode } = deps.child;
    if (exitCode !== null && exitCode !== undefined) {
      throw new Error(
        `worker process exited with code ${exitCode} before the run registered\n`
        + tailOfCommand(deps.readLogTail(), 300),
      );
    }

    if (now() >= deadline) {
      throw new Error(
        `run did not register within ${Math.round(deps.waitMs / 1000)}s\n`
        + tailOfCommand(deps.readLogTail(), 300),
      );
    }

    await sleep(pollMs);
  }
}

/** Reads back the launch log's own tail, never throwing when the file is not there yet
 *  (a child that failed before writing anything leaves nothing to read). */
function readLogTailFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
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

  // D2, 2026-09-06: `raw: true` -- this listing is parsed as data by `parseWorktreeList`
  // below, never shown to a person. Without it, `redact()` blanks a long ticket id or a
  // UUID-bearing path segment to `[REDACTED]` in the branch/path text this function
  // compares against a freshly computed (never-redacted) branch name, which can then
  // never match; the reuse check falls through to `git worktree add` on a worktree that
  // already exists. See exec.ts's `raw` option for the confirmed live failure.
  const list = await runner({
    argv: ['git', '-C', checkout, 'worktree', 'list', '--porcelain'],
    cwd: checkout, owner: `chain-${input.ticket}`, cls: 'script', raw: true,
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
      // F1: the same basename `forge run` itself gives this run -- ticket.toLowerCase()
      // guessed a name of its own, the live run this fixes actually registered under, and
      // the chain waited 45s on a row that was never going to appear under that guess.
      const runKey = runKeyForBrief(briefPath);

      const brief = readFileSync(briefPath, 'utf8');
      const completed = completeBriefWithVerification(brief, {
        ticket, repo, branch, base: baseFor(chainEnv, repo), verifyCommand: verifyCommandFor(chainEnv, repo),
      });
      if (completed !== brief) writeFileSync(briefPath, completed, 'utf8');

      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const name of WORKER_ENV_STRIP) delete env[name];
      env['CLAUDE_CONFIG_DIR'] = fleetConfigDir;
      env['FORGE_HOME'] = forgeHome();

      // E1, 2026-09-05: the parent's own runtime, never a path derived from
      // `import.meta.url` -- that path pointed at a `cli.js` sibling of this module
      // that does not exist when the parent itself is running from source under tsx,
      // and with `stdio: 'ignore'` the child's own "cannot find module" went nowhere.
      const logPath = join(runDir(runKey), 'launch.log');
      mkdirSync(dirname(logPath), { recursive: true });
      const logFd = openSync(logPath, 'a');
      let child: ChildProcess;
      try {
        child = spawn(
          process.execPath,
          chainLaunchArgv(process.execArgv, process.argv[1] ?? '', briefPath),
          { cwd: worktreePath, env, detached: true, stdio: ['ignore', logFd, logFd] },
        );
      } finally {
        closeSync(logFd);
      }
      child.unref();

      // E2: `chain.launched` is journaled by the caller (`chain.ts`'s `advancePacket`)
      // only when this resolves. Throwing here instead lands in that same caller's
      // existing catch, which journals `chain.blocked` on hop `launch` with this
      // error's own message -- so a run that never registered is never reported as one
      // that launched.
      await waitForLaunchToRegister({
        runKey,
        registry: new Registry(registryDir()),
        readEvents: () => replay(journalPath()).events,
        child,
        readLogTail: () => readLogTailFile(logPath),
        waitMs: launchWaitMs(),
      });

      return { runKey };
    },

    async status(runKey) {
      const state = replay(journalPath());
      // The journal carries no forge_done evidence text today (worker.ts's own gap,
      // named rather than papered over): the chain always falls back to `gh pr list`
      // for the PR itself.
      return runOutcome(runKey, { runs: state.runs, events: state.events });
    },

    async runRegistered(runKey) {
      return hasRunRegistered(runKey, {
        registry: new Registry(registryDir()),
        events: replay(journalPath()).events,
      });
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
