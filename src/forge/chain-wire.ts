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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** H2/H3: real worktrees, a real detached launch, and a real status read off the shared
 *  journal -- one `ChainLauncher` per `chain-env.ts` configuration, built fresh on every
 *  `forge up` process. */
export function chainLauncher(chainEnv: ChainEnv, fleetConfigDir: string): ChainLauncher {
  return {
    async provision({ ticket, repo }) {
      const checkout = checkoutFor(chainEnv, repo);
      if (!checkout) throw new Error(`no FORGE_REPO_CHECKOUTS entry for ${repo}`);
      const base = baseFor(chainEnv, repo);
      const worktreePath = worktreePathFor(checkout, repo, ticket);
      const branch = branchFor(ticket);

      mkdirSync(dirname(worktreePath), { recursive: true });
      const add = await execRun({
        argv: ['git', '-C', checkout, 'worktree', 'add', '-B', branch, worktreePath, `origin/${base}`],
        cwd: checkout, owner: `chain-${ticket}`, cls: 'script',
      });
      // A worktree that already exists for this branch is exactly the idempotent reuse
      // H2 asks for -- `git worktree add` itself refuses with a message naming the path,
      // which this treats as success rather than as a fresh failure to report.
      if (!add.ok && !add.tail.includes('already exists')) {
        throw new Error(tailOfCommand(add.tail));
      }

      await runWorktreeSetup({ chainEnv, repo, ticket, worktreePath });

      return { worktreePath, branch, base };
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
