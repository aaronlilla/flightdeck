#!/usr/bin/env node
/**
 * `forge` from a terminal.
 *
 *   forge up                  replay the journal, report, serve on 4120
 *   forge status              what every lane is doing, and what it costs
 *   forge run BRIEF           launch a goal, refusing the four launch mistakes
 *   forge send RUN TEXT       queue a message for a run already in flight
 *   forge answer KEY ANSWER   answer a question a worker parked on
 *   forge decide RUN kill R   the only way a kill decision id gets made
 *   forge stop --all          park every run with a handoff and end all spend
 *   forge queue add INPUT     queue a ticket, brief path or hotfix against the running server
 *   forge queue ls            list what is on the queue, filtered or as JSON
 *   forge inbox               Jira tickets waiting on a reply, an answer, or a status fix
 *   forge rounds [--apply]    the Conductor's walk around the board: what is stale and why; --apply acts
 *
 * `stop --all` is the control that has to work when nothing else does, so it takes no
 * arguments it could get wrong, is safe to run twice, and says plainly when there was
 * nothing to stop. It parks rather than kills: the work survives and `forge up` continues
 * it. A stop that lost an afternoon is a stop nobody dares press.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { QueryFn } from '../adapter/engine.js';
import { BlockerBoard } from './blockers.js';
import { readAttestation, writeAttestation } from './council/attest.js';
import { buildSquashMergeCall } from './council/gate.js';
import { planMergeIntent, planReadyIntent, recordMergeCall, reconcileMerge } from './council/externalize.js';
import { REAL_GH, type GhReader, type GhWriter } from './council/gh.js';
import { findHaipingHandoff } from './council/handoffScan.js';
import { runCouncilRound } from './council/orchestrate.js';
import { codexLaneFor, reasonerJudge, reasonerLensRunner } from './council/reasonerRoles.js';
import { autoMergeAllowed, councilPolicy, repoAllowedForCouncil } from './council/risk.js';
import { redactPrBody } from './council/redact-sinks.js';
import { SEVERITY_RANK } from './council/synthesis.js';
import { runCutover } from './cutover.js';
import { readLoginLock } from './credential-horizon.js';
import { buildBurnLedger, checkBudget } from './governor.js';
import { reconcileBurnOnce } from './burn-reconcile.js';
import { planIntakeWrites } from './intake/dryRun.js';
import { createJiraFeed, createJiraWriteClient, probeJira, type JiraWriteClient } from './intake/jira.js';
import { runJiraHandoff } from './intake/jiraHandoff.js';
import { runIntakeOnce } from './intake/once.js';
import type { FakePollFeed } from './intake/poller.js';
import { planFromPacket } from './intake/planner.js';
import { parseRepoMap } from './intake/repoRoute.js';
import { resolvePlanProvider } from './intake/reasoner.js';
import { readWatermark, writeWatermark, fileWatermarkStore } from './intake/watermarkStore.js';
import { fetchInboxIssues, classifyInbox } from './intake/inbox.js';
import { serverRequest } from './server-request.js';
import { readProcessList, watchedProcesses, probeProcessListCached } from './fleetwatch.js';
import { Gotchas } from './gotcha.js';
import { Inbox, isAskStale } from './inbox.js';
import { replay, Journal, JournalCache } from './journal.js';
import { checkLaunch, launchEnv, loginInFlight, pinnedRuntime, runtimeHead, runtimeVersion } from './launcher.js';
import { assess, LivenessSupervisor } from './liveness.js';
import { loadConsoleEnv } from './console-env.js';
import {
  ensureHome, fleetConfigDirChoice, forgeHome, gotchasDir, inboxDir, intakeBriefsDir, journalPath,
  killSwitchPath, lanesDir, queuePath, registryDir, runsDir,
} from './paths.js';
import { runQueueTick } from './intake/queue.js';
import { acquireQueueLock } from './intake/queueLock.js';
import { QueueStore } from './intake/queueStore.js';
import { buildQueueRuntimeDeps, queueMergeDeps, queuePromoteDeps, jiraConfigFromEnv } from './queue-wire.js';
import { readWatcherPollSeconds, watcherFeed, watcherTick } from './intake/watcherWire.js';
import { buildSelfLoop } from './self-wire.js';
import { QueueTickBackoff } from './queue-backoff.js';
import { loadPolicy, modelFor, modelIdFor, tierOfBrief } from './policy.js';
import { attestationCoversHead, checkHandoff, providerFor, redact, verified } from './contracts.js';
import type { CouncilAttestation, HaipingHandoff, JoeHandoff } from './contracts.js';
import { evaluateAction } from './rules/index.js';
import { readParkRecord } from './parkrecord.js';
import { processAlive, reconcileRegistry, Registry, relaunchAbandonedGoal } from './registry.js';
import { reasonerFor } from './reasoner-claude.js';
import { deliverAnswer, RunInbox } from './runinbox.js';
import { SdkEngine } from './sdkengine.js';
import { FORGE_PORT, ForgeServer } from './server.js';
import { Breaker, clearKillSwitch, Fleet, Lanes, readKillSwitch } from './supervisor.js';
import { WardenActuator } from './warden.js';
import { DriftCadenceTracker, WardenTick, type WardenTickRun } from './warden-tick.js';
import { renderToolCall } from './tool-target.js';
import { Worker, type EngineLike, type WorkerConfig } from './worker.js';
import {
  chainStatusLines, foldChainState, runChainTick, runKeyForBrief,
} from './chain.js';
import { readChainEnv, repoKindFor } from './chain-env.js';
import { buildChainDeps, hasRunRegistered } from './chain-wire.js';
import { isGoalFile } from './intake/goalFile.js';

export interface CliResult {
  code: number;
  lines: string[];
  /** P5.7: structured data a programmatic caller (the chain) reads instead of parsing
   *  `lines`. Additive only -- `council` sets `verdict`/`attestationPath` on a clean
   *  round, `gate` sets `merged`/`mergeSha`; every other command leaves this unset, and
   *  no existing caller reads it, so nothing about `lines`' own text changes. */
  data?: Record<string, unknown>;
}

export interface ForgeDeps {
  /** Overrides the production engine. Every specimen injects a fake here; nothing else may. */
  engine?: EngineLike;
  /** Overrides the verification commands' executor. Same rule: fakes only. */
  exec?: WorkerConfig['exec'];
  /** P4.7/I5: overrides `forge intake --once`'s feeds. Every specimen injects fixtures
   *  here; production passes none, since no real per-source client exists yet (decision
   *  1's Jira token is still unset), so a real `--once` run polls zero sources and says
   *  so honestly rather than fabricating a client. */
  intakeFeeds?: FakePollFeed[];
  /** Overrides the fleet's process-table reader that `status` and `up` feed into
   *  `watchedProcesses`. Every specimen injects a fixed list here; the production
   *  default (an explicit-undefined probe, which lets `watchedProcesses`'s own default
   *  parameter spawn the real `powershell`/`ps` read) is what made a CI runner's slower
   *  process probe a 5-second test timeout with no way for a specimen to avoid it. */
  processes?: () => string[];
  /** Overrides the pid-liveness check `up`'s registry reconcile reads. Production
   *  default: `processAlive` (a `process.kill(pid, 0)` signal probe). */
  alive?: (pid: number) => boolean;
  /** Overrides the `claude` provider's own SDK `query`. Every specimen injects a fake
   *  here; nothing else may -- production leaves this unset and gets the real SDK. */
  reasonerQueryFn?: QueryFn;
  /** Overrides `forge council`/`forge gate`'s own `gh` reader and writer. Every specimen
   *  injects a fake here; production leaves this unset and gets `REAL_GH`. */
  councilGh?: GhReader & GhWriter;
  /** Forge Jira stream: overrides the `fetch` every real Jira call (J1, J3, J4) is built
   *  on. Every specimen injects a fake here; production leaves this unset and gets the
   *  global `fetch` Node already provides. */
  fetchFn?: typeof fetch;
  /** Overrides `forge gate --merge`'s Jira write client (J3). Production builds one from
   *  `FORGE_JIRA_SITE`/`FORGE_JIRA_EMAIL`/`FORGE_JIRA_TOKEN` when all three are set;
   *  every specimen injects a fake here instead. */
  jiraWrite?: JiraWriteClient;
  /** P5.7: `forge council` forces the Codex lane's own policy check to `'on'` for this
   *  round and asks `runCouncilRound` to run it regardless of diff size or path -- the
   *  chain's `FORGE_COUNCIL_CODEX=always` sets this on every chain council call. */
  forceCodexLane?: boolean;
}

/** Item 4, 2026-09-05: how old a lane's own file has to be, with no live registry row
 *  behind it, before `forge clear --stale` deletes it and `forge status` stops showing
 *  it by default. */
const STALE_LANE_MS = 24 * 3_600_000;

/**
 * Forge Jira stream: the three variables a real Jira poll or probe needs, all or
 * nothing. `FORGE_JIRA_JQL`, `FORGE_JIRA_QA_ACCOUNT` and `FORGE_JIRA_QA_TRANSITION` are
 * each optional on their own and read where they are used, never here.
 */
const JIRA_ENV_VARS = ['FORGE_JIRA_SITE', 'FORGE_JIRA_EMAIL', 'FORGE_JIRA_TOKEN'] as const;

/**
 * The fleet's process table for `status` and `up`, read through `deps.processes` when a
 * specimen supplies one. `watchedProcesses`'s own parameter defaults to a real
 * `probeProcessList()` call, evaluated fresh each time the argument is left out -- passing
 * `undefined` explicitly here (the production path) hits that same default, so nothing
 * about a real run's behavior changes; passing an injected list instead skips the real
 * probe outright, since a supplied argument always wins over a default one.
 */
function fleetSnapshot(deps: ForgeDeps): ReturnType<typeof watchedProcesses> {
  return watchedProcesses(deps.processes ? { ok: true, lines: deps.processes() } : probeProcessListCached());
}

/**
 * The 2026-09-05 fix, at the one command that ever printed the bug: one quiet line for
 * every fleet process `assess` never watches (an interactive terminal, the Chrome
 * extension's native host), instead of the three false `STUCK stale-session` rows those
 * kinds used to produce. `undefined` when there is nothing of the kind to report, so a
 * clean fleet stays silent about it.
 */
function fleetNoticeLine(fleet: Awaited<ReturnType<typeof watchedProcesses>>): string | undefined {
  if (!Array.isArray(fleet)) return undefined;
  const interactive = fleet.filter((proc) => proc.kind === 'interactive').length;
  const nativeHost = fleet.filter((proc) => proc.kind === 'native-host').length;
  if (!interactive && !nativeHost) return undefined;
  const parts: string[] = [];
  if (interactive) parts.push(`${interactive} interactive claude session${interactive === 1 ? '' : 's'}`);
  if (nativeHost) parts.push(`${nativeHost} native host${nativeHost === 1 ? '' : 's'}`);
  return `${parts.join(' and ')}, not fleet, not watched`;
}

/**
 * A fleet snapshot's runs, from the journal's own replayed state.
 *
 * Shared by `status` and `up` so there is exactly one place that reads a run's model-policy
 * class off `RunState` rather than assuming `implement` for every run.
 */
/**
 * P4.7/I5: `forge intake --once`'s watermark, persisted as one small JSON file per
 * source under `~/.forge/intake/`, so a second CLI invocation does not re-observe
 * everything the first one already saw. No stream before this integration built any
 * on-disk store for it (every specimen kept its watermark in memory for the one call
 * under test), so this is the first place it survives a process exit.
 */
// Moved to `intake/watermarkStore.ts` (P5.7) so `chain-wire.ts` reads and writes the
// exact same files rather than a second, divergent copy of this logic.

function snapshotRuns(
  state: ReturnType<typeof replay>,
  registry?: Registry,
  alive: (pid: number) => boolean = processAlive,
): Array<{
  run: string; className: string; lastEventAt: number; context: number;
  currentTool?: { name: string; startedAt: number };
  registryLive?: boolean; registryRowRemains?: boolean;
}> {
  // A finished, handed-off or parked run's lastEventAt is frozen at whatever it was when
  // it stopped, while `now` keeps moving; fed to assess() unfiltered, every one of them
  // trips the idle signal forever and LivenessSupervisor never clears it, since the trip
  // never stops reappearing. Only a run still actually going belongs in the snapshot.
  return Object.values(state.runs)
    .filter((run) => run.state === 'started')
    .map((run) => {
      const base = {
        run: run.run, className: run.className ?? 'implement', lastEventAt: run.lastEventAt,
        context: run.context, ...(run.currentTool ? { currentTool: run.currentTool } : {}),
      };
      // I15: a run whose process died mid-tool-call leaves the fold above exactly as it
      // was at the moment of death -- a `tool.start` with no `tool.end` reads as a tool
      // still in flight no matter how long the process has actually been gone. Without a
      // registry to check against, `registryLive` stays undefined and `assess` reads the
      // run as live, unchanged from before this fix. With one, only a registry row whose
      // pid is still alive counts as live; a dead or missing row never trips admission.
      if (!registry) return base;
      const row = registry.get(run.run);
      if (!row) return { ...base, registryLive: false };
      const live = alive(row.pid);
      return { ...base, registryLive: live, ...(live ? {} : { registryRowRemains: true }) };
    });
}

/**
 * Item 8, 2026-09-05: whether `briefPath` opens under a goals directory (any path
 * segment literally named `goals`) somewhere other than that directory's own `logs/`
 * subdirectory. `.claude/goals/logs/` is where probe and smoke briefs live and get
 * cleaned up; `.claude/goals/` itself is where a real goal brief -- one whose outcome a
 * person actually reads -- lives. A path with no `goals` segment at all (a specimen's
 * temp directory, an ad hoc brief elsewhere) is never a real goal brief either, so it
 * reads as allowed, the same as `logs/`.
 */
function briefUnderRealGoalsDir(briefPath: string): boolean {
  const parts = briefPath.split(/[\\/]/);
  const goalsIndex = parts.findIndex((part) => part.toLowerCase() === 'goals');
  if (goalsIndex === -1) return false;
  return parts[goalsIndex + 1]?.toLowerCase() !== 'logs';
}

/**
 * `forge run`'s arguments past the brief path: `--dry-run`, `--max-context N`,
 * `--max-turns N`, and whatever words are left over become the condition.
 */
function parseRunArgs(rest: string[]): {
  dryRun: boolean; maxContext?: number; maxTurns?: number; condition: string; invalid?: string;
  autoAnswer?: string; goal: boolean; runKey?: string;
} {
  let dryRun = false;
  let goal = false;
  let maxContext: number | undefined;
  let maxTurns: number | undefined;
  let invalid: string | undefined;
  let autoAnswer: string | undefined;
  let runKey: string | undefined;
  const words: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--dry-run') { dryRun = true; continue; }
    // 2026-09-08: a `goal` queue item's launch -- the argument past the goal path is
    // the resolved /goal condition itself, never file contents, and this flag is what
    // tells `forge run` so, the same way `chainLaunchGoalArgv` builds its argv.
    if (token === '--goal') { goal = true; continue; }
    // 2026-09-08 (BBZ collision fix): names this run's own key instead of letting it
    // fall back to `runKeyForBrief`'s bare basename -- two queue items launched off
    // the same goal file otherwise collide on both the run directory and the
    // registry row the second launch's `waitForLaunchToRegister` would then read as
    // already-registered from the first.
    if (token === '--run-key') {
      const raw = rest[index += 1];
      if (!raw) invalid ??= '--run-key needs a value';
      runKey = raw;
      continue;
    }
    if (token === '--max-context') {
      const raw = rest[index += 1];
      const value = Number(raw);
      if (!Number.isFinite(value)) invalid ??= `--max-context needs a number, got ${raw ?? '(nothing)'}`;
      maxContext = value;
      continue;
    }
    if (token === '--max-turns') {
      const raw = rest[index += 1];
      const value = Number(raw);
      if (!Number.isFinite(value)) invalid ??= `--max-turns needs a number, got ${raw ?? '(nothing)'}`;
      maxTurns = value;
      continue;
    }
    if (token === '--auto-answer') {
      const raw = rest[index += 1];
      if (raw === undefined) invalid ??= '--auto-answer needs the text to answer every ask with';
      autoAnswer = raw;
      continue;
    }
    words.push(token);
  }
  return {
    dryRun, goal, condition: words.join(' '),
    ...(maxContext !== undefined ? { maxContext } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(autoAnswer !== undefined ? { autoAnswer } : {}),
    ...(runKey !== undefined ? { runKey } : {}),
    ...(invalid ? { invalid } : {}),
  };
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Same shape `queue-route.ts` checks a ticket source's input against: a project
 *  prefix, a dash, a number. */
const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Run one command and say what happened.
 *
 * Returns rather than printing, so the specimens can read the outcome and `main` stays
 * the only place that writes to a terminal.
 */
export async function forge(argv: string[], deps: ForgeDeps = {}): Promise<CliResult> {
  const [command, ...rest] = argv;
  // A terminal run of `forge` otherwise sees none of the console's FORGE_* variables:
  // see console-env.ts. FORGE_NO_CONSOLE_ENV=1 opts out.
  if (process.env['FORGE_NO_CONSOLE_ENV'] !== '1') {
    loadConsoleEnv(join(forgeHome(), 'console.env.cmd'), process.env);
  }
  ensureHome();
  const lanes = new Lanes(lanesDir());
  const inbox = new Inbox(inboxDir());

  switch (command) {
    case 'status': {
      const state = replay(journalPath());
      const statusRegistry = new Registry(registryDir());
      const fleet = fleetSnapshot(deps);
      const stuckRows = assess({
        now: Date.now(),
        runs: snapshotRuns(state, statusRegistry, deps.alive),
        fleet,
      })
        .filter((trip) => trip.signal !== 'registry-abandoned')
        .map((trip) => `STUCK  ${trip.key.padEnd(24)} ${trip.signal.padEnd(14)} ${trip.hint}`);
      const fleetNotice = fleetNoticeLine(fleet);
      // Item 4, 2026-09-05: a lane's file survives long after its chain finished, so a
      // fleet that ran for weeks accumulates one row per goal ever launched. `--all`
      // still shows every one of them; the default view hides anything untouched for
      // longer than STALE_LANE_MS, the same threshold `forge clear --stale` deletes by.
      const showAll = rest.includes('--all');
      const rows = lanes.all()
        .filter((lane) => {
          if (showAll) return true;
          const mtime = lanes.mtimeOf(lane.slug);
          return mtime === undefined || Date.now() - mtime < STALE_LANE_MS;
        })
        .map((lane) => [
        lane.slug.padEnd(28),
        (lane.model ?? '-').padEnd(18),
        `ctx ${String(lane.context ?? 0).padStart(7)}`,
        money(lane.cost_usd ?? 0).padStart(9),
        lane.needs_aaron ? 'NEEDS AARON' : (lane.verdict ?? 'running'),
      ].join(' '));
      const openAsks = inbox.open();
      const waiting = openAsks.length;
      // F3: none of an ask's runs still having a registry row means answering it resumes
      // nothing. Counted separately from `waiting` rather than dropped from it: a stale
      // ask is still open until `forge clear --all` retires it, and the count is what
      // says the "1 waiting" on screen is not actually worth Aaron's time.
      const stale = openAsks.filter(
        (entry) => isAskStale(entry, (run) => Boolean(statusRegistry.get(run))),
      ).length;
      // P5.7: one row per packet the chain has ever seen, alongside the lane rows --
      // present whether or not FORGE_CHAIN is on today, since a packet already in
      // flight from an earlier `forge up` still deserves to show here. Computed before
      // the "nothing is running" check below: the 2026-09-05 CI failure was this line
      // sitting after that check, so a chain packet on an otherwise clean fleet (no
      // lanes, no waiting asks, no fleet notice -- exactly what a fresh CI runner looks
      // like) got the packet folded and then thrown away unread.
      const chainRows = chainStatusLines(foldChainState(state.events));
      // An idle fleet says one thing and stops. Appending "inbox: 0 waiting" to it made
      // "nothing is running" impossible to say, which is the answer a person most wants.
      if (!rows.length && !waiting && !state.torn && !stuckRows.length && !fleetNotice && !chainRows.length) {
        return { code: 0, lines: ['nothing is running'] };
      }
      if (state.torn) {
        rows.push(`journal: ${state.torn} torn line(s), which is a crash somebody should read`);
      }
      rows.push(`inbox: ${waiting} waiting${stale ? ` (${stale} stale)` : ''}`);
      if (fleetNotice) rows.push(fleetNotice);
      return { code: 0, lines: [...stuckRows, ...rows, ...chainRows] };
    }

    case 'up': {
      // A supervisor of paid workers never dies on one stray promise. Node's default
      // for an unhandled rejection is to exit, and on 2026-09-08 one failed `gh` spawn
      // inside a background PR read took the console down four times in seven minutes,
      // stranding every worker it had launched. Journal it, print it, carry on.
      const guardJournal = new Journal(journalPath());
      process.on('unhandledRejection', (reason) => {
        const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        console.error(`unhandled rejection (console stays up): ${message}`);
        try {
          guardJournal.append({ event: 'console.unhandled', actor: 'console', kind: 'rejection', message: message.slice(0, 2000) });
        } catch {
          // The journal itself failing must not turn a survived rejection into an exit.
        }
      });
      const state = replay(journalPath());

      // Before anything else starts: pick up whatever the registry says crashed. A row
      // with a live pid is left alone (some other process still owns it); a row with a
      // dead pid and a session id gets exactly one resume attempt; a row with no session
      // id at all cannot be resumed and is only reported.
      const registry = new Registry(registryDir());
      const reconcileEngine = deps.engine ?? new SdkEngine({
        journalPath: journalPath(), inboxDir: inboxDir(), gotchasDir: gotchasDir(),
      });
      // A resume runs the crashed session to its next stop inside this process, which can
      // be a whole working session. Seen live on 2026-09-07: `forge up` sat for minutes
      // with no listener while a resumed run worked, so the board was dark and a second
      // launch was tempting. The reconcile therefore runs in the background; the server
      // listens first, and each outcome lands in the journal as it happens.
      const reconcileJournal = new Journal(journalPath());
      const reconcileLines = [`reconciling ${registry.all().length} registry row(s) in the background`];
      const reconcileInbox = new Inbox(inboxDir());
      const reconciling = reconcileRegistry(
        registry, reconcileEngine, reconcileJournal, deps.alive, undefined,
        (goal) => reconcileInbox.open().some((entry) => entry.runs.includes(goal) || entry.goals.includes(goal)),
      )
        .then((reconciled) => {
          for (const outcome of reconciled) {
            reconcileJournal.append({
              event: 'note', actor: 'runner', run: outcome.goal,
              message: outcome.ok ? 'reconciled: resumed by session id' : `could not reconcile: ${outcome.reason}`,
            } as never);
          }
        })
        .catch((error: unknown) => {
          reconcileJournal.append({ event: 'note', actor: 'runner', message: `reconcile failed: ${error instanceof Error ? error.message : String(error)}` } as never);
        })
        .finally(() => { reconcileJournal.close(); void reconcileEngine.close?.(); });
      if (deps.engine) await reconciling; // a specimen's fake engine resolves at once; keep its ordering

      // P4.7/I4: the `claude` provider behind every `Reasoner` seam this process wires
      // up below -- the router here and the Warden tick's conformance drift further
      // down. `deps.reasonerQueryFn` is the only override, for specimens; every real
      // run gets the SDK's own `query` (`Engine`'s default).
      const reasonerJournal = new Journal(journalPath());
      const reasoner = reasonerFor('claude', {
        journal: reasonerJournal, queryFn: deps.reasonerQueryFn,
      });

      const sharedJournalCache = new JournalCache();
      // The intake queue's own log, shared between the board's routes (added below by
      // `ForgeServer` itself) and the worker tick further down -- one `QueueStore`, so
      // an add from the console and an advance from the worker are never reading two
      // different views of the same file mid-tick.
      const queueStore = new QueueStore(queuePath());
      // Queue-throughput W2: FORGE_QUEUE_MAX_IN_FLIGHT seeds the on-disk width for this
      // `forge up` -- an out-of-range or non-integer value is the same as not setting it
      // at all, since ForgeServer's own `?? 4` default is the honest fallback, not a
      // half-applied env value.
      const envQueueMaxInFlight = Number(process.env['FORGE_QUEUE_MAX_IN_FLIGHT']);
      const queueMaxInFlight = Number.isInteger(envQueueMaxInFlight)
        && envQueueMaxInFlight >= 1 && envQueueMaxInFlight <= 12
        ? envQueueMaxInFlight
        : undefined;
      const server = new ForgeServer({
        lanes, inbox, journalPath: journalPath(), journalCache: sharedJournalCache, registry,
        stuck: () => liveness.stuck(),
        reasoner,
        fleet: () => {
          const read = fleetSnapshot(deps);
          return Array.isArray(read) ? read.map((proc) => ({ ...proc })) : read;
        },
        queueStore,
        ...(queueMaxInFlight !== undefined ? { queueMaxInFlight } : {}),
        // A.7: Merge and Promote are clicks. Merge reuses the gate with `merge: true` for
        // repos on FORGE_QUEUE_MERGE_REPOS and then reads the develop deploy's outcome per
        // platform; Promote reports whether the production workflow exists and refuses
        // the dispatch until that decision is wired.
        queueMergeDeps: queueMergeDeps(deps, queueStore, readChainEnv()),
        queuePromoteDeps: queuePromoteDeps(readChainEnv()),
      });
      const livenessJournal = new Journal(journalPath());
      const liveness = new LivenessSupervisor(
        () => ({
          now: Date.now(),
          runs: snapshotRuns(sharedJournalCache.read(journalPath()), registry, deps.alive),
          fleet: fleetSnapshot(deps),
        }),
        livenessJournal,
        (event) => server.publish(event),
      );
      // P4.7/I2, wired live by P4.7/I4: the Warden tick, wiring reportFleetHealth,
      // assessCostShape, ConformanceDrift (a real `reasoner` below, so drift checks
      // fire an actual `evaluate`-class call rather than staying dormant) and the
      // actuator's park onto the same 30s cadence liveness already runs on.
      const wardenJournal = new Journal(journalPath());
      const wardenActuator = new WardenActuator({
        journal: wardenJournal, journalPath: journalPath(), registry, lanes,
      });
      const wardenBlockers = new BlockerBoard({ journal: wardenJournal, actuator: wardenActuator });
      // B.9: every 10 turns or 5 minutes per run, replacing the "always due" default.
      const driftCadence = new DriftCadenceTracker();
      // B.2: a fresh engine for the one relaunch a registry-abandoned goal ever gets from
      // this tick -- built once, reused across every relaunch this `forge up` process
      // ever attempts, the same as the reconcile engine above but kept open for the
      // process's lifetime rather than closed after the startup pass.
      const relaunchEngine = deps.engine ?? new SdkEngine({
        journalPath: journalPath(), inboxDir: inboxDir(), gotchasDir: gotchasDir(),
      });
      const wardenTick = new WardenTick({
        journal: wardenJournal,
        actuator: wardenActuator,
        blockers: wardenBlockers,
        reasoner,
        now: () => Date.now(),
        stuck: () => liveness.stuck(),
        isRegisteredRun: (key: string) => Boolean(registry.get(key)) || Boolean(lanes.get(key)),
        relaunchAbandoned: (goal: string) => relaunchAbandonedGoal(registry, relaunchEngine, goal),
        registryRows: () => registry.all(),
        isAlive: (pid) => (deps.alive ?? processAlive)(pid),
        parkedAt: (goal) => readParkRecord(goal)?.at,
        releaseRegistryRow: (goal) => registry.remove(goal),
        markLaneDead: (goal) => { lanes.put(goal, { verdict: 'dead' }); },
        killSwitch: () => readKillSwitch(killSwitchPath()),
        dueForConformanceCheck: (run) => {
          const fleetState = sharedJournalCache.read(journalPath());
          return driftCadence.isDue(run, fleetState.runs[run]?.turns ?? 0, Date.now());
        },
        liveRuns: (): WardenTickRun[] => {
          const fleetState = sharedJournalCache.read(journalPath());
          return Object.values(fleetState.runs)
            .filter((run) => run.state === 'started')
            .map((run) => {
              const admitted = registry.get(run.run);
              let brief: string | undefined;
              try {
                brief = admitted ? readFileSync(admitted.briefPath, 'utf8') : undefined;
              } catch {
                brief = undefined;
              }
              const recentToolCalls = fleetState.events
                .filter((event) => event.run === run.run && event.event === 'tool.start')
                .slice(-8)
                .map((event) => renderToolCall(
                  String(event['tool'] ?? ''),
                  typeof event['target'] === 'string' ? event['target'] : undefined,
                ));
              return {
                run: run.run,
                ...(brief !== undefined ? { brief } : {}),
                recentToolCalls,
                costShape: {
                  run: run.run, context: run.context, cacheReadTokens: run.cacheReadTokens,
                  totalReadTokens: run.totalReadTokens, turnsSinceWrite: run.turnsSinceWrite,
                },
              };
            });
        },
      });

      // P4.7/I3: the Governor's burn reconciliation, on the same cadence, deduped per run
      // for this process's lifetime so an unresolved mismatch is journaled once.
      const burnReported = new Set<string>();
      const burnJournal = new Journal(journalPath());

      const port = await server.listen();
      const tick = setInterval(() => {
        liveness.evaluate();
        void wardenTick.run();
        try {
          const fleetState = sharedJournalCache.read(journalPath());
          for (const event of reconcileBurnOnce(fleetState, burnReported)) burnJournal.append(event);
        } catch {
          // Guarded the same as every other tick step: one bad read never stops liveness
          // or the Warden tick that already ran this cycle.
        }
      }, 30_000);
      tick.unref();

      // P5.7: `FORGE_CHAIN=1` turns this on; off, `forge up` behaves exactly as it did
      // before this stream. Its own timer, at `FORGE_CHAIN_POLL_S` (default 300s), so a
      // slow intake poll never competes with liveness/Warden's 30s cadence above.
      const chainEnv = readChainEnv();
      let chainLine = '';
      if (chainEnv.enabled) {
        const chainJournal = new Journal(journalPath());
        const chainDeps = buildChainDeps(chainEnv, fleetConfigDirChoice().dir, deps);
        const chainTick = setInterval(() => {
          void (async () => {
            try {
              const chainState = foldChainState(sharedJournalCache.read(journalPath()).events);
              await runChainTick(chainDeps, chainState);
            } catch (error) {
              chainJournal.append({
                event: 'chain.tick-error', actor: 'chain',
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
        }, chainEnv.pollSeconds * 1000);
        chainTick.unref();
        chainLine = `chain on, polling every ${chainEnv.pollSeconds}s`;
      }

      // The intake queue's own worker: `FORGE_QUEUE=1` turns it on, the same opt-in
      // shape as the chain above. Its own timer, at `FORGE_QUEUE_POLL_S` (default 15s)
      // -- an operator adding a ticket wants it picked up quickly, unlike a poll cycle
      // that already ran once before anything reached the chain.
      let queueLine = '';
      // One process ticks this queue at a time (`intake/queueLock.ts`): a second `forge up`
      // on a port the platform let it share would otherwise plan every item twice.
      const queueLock = process.env['FORGE_QUEUE'] === '1'
        ? acquireQueueLock({ path: join(dirname(queuePath()), 'queue.lock'), pid: process.pid, alive: processAlive })
        : undefined;
      if (queueLock && !queueLock.ok) {
        queueLine = `queue NOT started: ${queueLock.reason}`;
      }
      if (queueLock?.ok) {
        process.once('exit', () => queueLock.release());
        const queueJournal = new Journal(journalPath());
        const queueDeps = buildQueueRuntimeDeps(chainEnv, fleetConfigDirChoice().dir, deps, queueStore);
        const pollSeconds = Number(process.env['FORGE_QUEUE_POLL_S']) || 15;
        // B.1: three identical consecutive queue.tick-error rows back this off to a
        // 10 minute drip rather than retrying every pollSeconds all night on the same
        // dead Jira token; any change in the error resumes it at once.
        const queueBackoff = new QueueTickBackoff(queueJournal);
        const queueTick = setInterval(() => {
          if (!queueBackoff.dueToRun()) return;
          void runQueueTick(queueDeps, queueStore.all())
            .then(() => queueBackoff.onSuccess())
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              queueJournal.append({ event: 'queue.tick-error', actor: 'queue', message });
              queueBackoff.onError(message);
            });
        }, pollSeconds * 1000);
        queueTick.unref();
        queueLine = `queue on, polling every ${pollSeconds}s`;
      }

      // R-11 part 2: the Jira watcher bridge -- FORGE_BACKLOG_PROJECT names the project it
      // watches, the same variable buildBacklogJql already reads for a backlog add. Its own
      // timer at FORGE_CHAIN_POLL_S seconds (default 30, not the chain's 300s default),
      // since a comment or a status move on an owned ticket should reach the queue fast.
      let watcherLine = '';
      const watcherProject = process.env['FORGE_BACKLOG_PROJECT'];
      const watcherJiraConfig = jiraConfigFromEnv();
      if (!watcherProject) {
        watcherLine = 'jira watcher NOT started: no FORGE_BACKLOG_PROJECT';
      } else if (!watcherJiraConfig) {
        watcherLine = 'jira watcher NOT started: no Jira credentials';
      } else {
        const watcherJournal = new Journal(journalPath());
        const watcherPollSeconds = readWatcherPollSeconds();
        const watermarks = fileWatermarkStore();
        const feed = watcherFeed(watcherProject, watcherJiraConfig);
        const watcherTickTimer = setInterval(() => {
          void watcherTick({
            feed, watermarks, store: queueStore, journal: watcherJournal,
          }).catch((error: unknown) => {
            watcherJournal.append({
              event: 'watcher.tick-error', actor: 'watcher',
              message: error instanceof Error ? error.message : String(error),
            } as never);
          });
        }, watcherPollSeconds * 1000);
        watcherTickTimer.unref();
        watcherLine = `jira watcher on for ${watcherProject}, every ${watcherPollSeconds}s`;
      }

      // The self loop (`self-wire.ts`): findings about the fleet become queue items on
      // FORGE_SELF_REPO, a self item whose gate cleared merges, and once trunk has moved
      // this process asks its launcher for a restart by exiting 75 -- only while nothing
      // is in flight, and never by touching a worker.
      let selfLine = '';
      const selfLoop = buildSelfLoop({
        chainEnv: readChainEnv(), store: queueStore,
        mergeDeps: queueMergeDeps(deps, queueStore, readChainEnv()), runningHead: runtimeHead(),
      });
      if (selfLoop.enabled && queueLock?.ok) {
        const selfSeconds = Number(process.env['FORGE_SELF_POLL_S']) || 300;
        const selfJournal = new Journal(journalPath());
        const selfTick = setInterval(() => {
          void selfLoop.tick().then((result) => {
            if (!result.restart) return;
            clearInterval(selfTick);
            process.stdout.write(`self: trunk moved past ${runtimeVersion()}, restarting onto it
`);
            void server.close().finally(() => process.exit(75));
          }).catch((error) => {
            selfJournal.append({ event: 'self.tick-error', actor: 'self', message: error instanceof Error ? error.message : String(error) } as never);
          });
        }, selfSeconds * 1000);
        selfTick.unref();
        selfLine = `self loop on for ${selfLoop.selfRepo}, every ${selfSeconds}s`;
      } else if (selfLoop.enabled) {
        selfLine = 'self loop NOT started: the queue lock is held elsewhere';
      }
      server.selfStatus = () => selfLoop.status();

      return {
        code: 0,
        lines: [
          `forge ${runtimeVersion()} up on http://127.0.0.1:${port}`,
          `replayed ${state.events.length} events, ${Object.keys(state.runs).length} run(s)`,
          state.torn ? `${state.torn} torn journal line(s) survived and were skipped` : '',
          ...reconcileLines,
          `inbox: ${inbox.open().length} waiting`,
          chainLine,
          queueLine,
          watcherLine,
          selfLine,
        ].filter(Boolean),
      };
    }

    case 'run': {
      const briefPath = rest[0];
      if (!briefPath) return { code: 2, lines: ['forge run needs a brief path'] };
      let brief: string;
      try {
        brief = readFileSync(briefPath, 'utf8');
      } catch (error) {
        return { code: 2, lines: [`cannot read ${briefPath}: ${(error as Error).message}`] };
      }
      const { dryRun, goal, maxContext, maxTurns, condition, invalid, autoAnswer, runKey: runKeyArg } = parseRunArgs(rest.slice(1));
      if (invalid) {
        // Refused before checkLaunch and before any lane is written: a NaN ceiling never
        // fires, which is the exact silent-unbounded-run this check exists to close.
        return { code: 2, lines: [`refusing to start: ${invalid}`] };
      }
      // 2026-09-08: `--goal` -- `briefPath` was still read above (so a bad path fails
      // the same way for both, and the file's own text still reaches the log and
      // `tierOfBrief`/`checkLaunch`'s scan), but the Worker's actual first prompt is
      // the resolved /goal condition, never that file's contents.
      if (goal) {
        if (!condition) return { code: 2, lines: ['forge run --goal needs the /goal condition as its second argument'] };
        brief = condition;
      }
      // Item 8, 2026-09-05: --auto-answer is for a probe or smoke run only -- a brief
      // that opens under a real goals directory (`.claude/goals/`, outside its own
      // `logs/` subdirectory, where probes and smoke briefs live) never gets it, since
      // nothing should silently answer its own questions on a run someone will actually
      // read the outcome of.
      if (autoAnswer !== undefined && briefUnderRealGoalsDir(briefPath)) {
        return {
          code: 2,
          lines: ['refusing to start: --auto-answer is for a probe or smoke run under a '
            + 'goals directory\'s own logs/ subdirectory, never for a real goal brief'],
        };
      }
      const verdict = checkLaunch({
        brief,
        condition: condition || 'Work the brief to completion.',
        loginRunning: loginInFlight(),
        killSwitch: readKillSwitch(killSwitchPath()),
      });
      if (!verdict.ok) {
        return { code: 1, lines: ['refusing to start:', ...verdict.refusals.map((r) => `  ${r}`)] };
      }
      const slug = runKeyArg ?? runKeyForBrief(briefPath);
      const pin = pinnedRuntime(slug);
      const breaker = new Breaker(lanes);
      const configDir = fleetConfigDirChoice();
      const configDirLine = `config dir: ${configDir.dir} (${configDir.source})`;

      if (dryRun) {
        lanes.put(slug, { column: 'forge', started: Date.now() });
        return {
          code: 0,
          lines: [
            `${slug} pinned to forge ${pin.version}`,
            `CLAUDE_CONFIG_DIR=${launchEnv()['CLAUDE_CONFIG_DIR']}`,
            configDirLine,
          ],
        };
      }

      if (breaker.blocked(slug)) {
        return {
          code: 1,
          lines: [
            `refusing to start ${slug}: ${lanes.get(slug)?.needs_aaron}`,
            `run forge clear ${slug} once you have looked at why it kept failing to start`,
          ],
        };
      }

      // P4.7/I2: CredentialHorizon is consulted before every launch. The fleet's config
      // dir IS the account this run authenticates as, so a login flow already in flight
      // for it (another `forge run` process's `onLapse` holding `~/.forge/logins/*.lock`)
      // means this launch would open a second, racing login on the same account rather
      // than parking behind the one already running. A lock whose pid is no longer alive
      // is stale, per `credential-horizon.ts`'s own rule, and never blocks a launch.
      const lockHolder = readLoginLock(configDir.dir);
      if (lockHolder && processAlive(lockHolder.pid)) {
        return {
          code: 1,
          lines: [
            `refusing to start ${slug}: credential horizon has a login flow already in `
              + `flight for ${configDir.dir} (pid ${lockHolder.pid})`,
          ],
        };
      }

      // P4.7/I3: admission never refuses on a list-priced total. What a run "would spend" is unknowable
      // before it opens a session, so this is a daily-cap gate in practice: today's
      // No money gate here any more. This fleet runs on a flat subscription, so the
      // figure this used to compare against `dailyUsd` was tokens multiplied by list
      // prices: an invented quantity. Worse, it summed the whole burn ledger rather than
      // today's, so it only ever climbed, and would eventually have refused every launch
      // for good on a number that never described anything real. What actually limits
      // work is how many runs a person can supervise at once, which the queue holds at
      // two, and the per-run token ceiling the board shows. `checkBudget` itself stays
      // for callers that pass a real ceiling.
      const launchClass = tierOfBrief(brief);

      const registry = new Registry(registryDir());
      const admission = registry.admit({
        goal: slug, cwd: process.cwd(), briefPath, pid: process.pid,
      });
      if (!admission.ok) {
        return { code: 1, lines: [`refusing to start ${slug}: ${admission.reason}`] };
      }

      // Written here too, not only by the journal's own `run.started` fold: a board
      // polling `/state` between admission and the worker's first event otherwise reads
      // "unknown class" and a stale model for however long the launch takes to reach its
      // first turn.
      const plannedClassName = tierOfBrief(brief);
      const plannedModel = modelIdFor(modelFor(plannedClassName));
      lanes.put(slug, {
        column: 'forge', started: Date.now(), owner: 'forge',
        className: plannedClassName, model: plannedModel,
      });
      const engine = deps.engine ?? new SdkEngine({
        journalPath: journalPath(), inboxDir: inboxDir(), gotchasDir: gotchasDir(),
        killSwitch: () => readKillSwitch(killSwitchPath()).engaged,
        // I12: written the moment the SDK's init message names the session, not after
        // the first turn resolves -- a process killed mid-segment still leaves a
        // registry row and a lane `reconcileRegistry` can resume.
        onSessionStarted: (_run, sessionId, model) => {
          registry.setSession(slug, sessionId, model);
          lanes.put(slug, { session_id: sessionId });
        },
      });
      // P4.7/I9: the real actuator, so a model-mismatch turn actually parks (writes the
      // park record the PreToolUse hook checks on this run's own next tool call) rather
      // than only journaling `governor.parked`/`warden.parked` with nothing acting on it.
      // Built unconditionally, including under a fake engine a specimen injects: I9's own
      // falsifier is a specimen that gets this wiring only by passing an actuator itself.
      const actuatorJournal = new Journal(journalPath());
      const actuator = new WardenActuator({
        journal: actuatorJournal, journalPath: journalPath(), registry, lanes,
      });
      const worker = new Worker({
        run: slug,
        brief,
        briefPath,
        cwd: process.cwd(),
        journalPath: journalPath(),
        engine,
        actuator,
        // P4.7/I8: the same kill switch `forge stop --all` engages, consulted on every
        // poll of a run parked on an ask (F1) so a stop reaches a run waiting on a
        // person, not only one still taking turns.
        killSwitch: () => readKillSwitch(killSwitchPath()).engaged,
        onSessionStarted: (_run, sessionId, model) => registry.setSession(slug, sessionId, model),
        ...(deps.exec ? { exec: deps.exec } : {}),
        ...(maxContext !== undefined ? { maxContext } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(autoAnswer !== undefined ? { autoAnswer } : {}),
        ...(goal ? { goalLoop: true } : {}),
      });
      let result: Awaited<ReturnType<Worker['run']>>;
      try {
        result = await worker.run();
      } finally {
        // Awaited rather than fired-and-forgotten (F4): a `close()` that stops a live
        // engine's SDK child process is exactly the cleanup this process must not exit
        // ahead of, or the child outlives the `forge run` that opened it.
        await engine.close?.();
        actuatorJournal.close();
        registry.remove(slug);
      }
      const started = result.sessions[0];
      // A session that opened and closed without a single turn is a failed start, not a
      // worker being quiet; three of those in fifteen minutes is the exact 2026-09-03
      // thrash this breaker exists to stop, so it has to see every real launch.
      if (result.sessions.length === 1 && result.turns === 0) {
        breaker.noteZeroTurnStart(slug);
      } else {
        breaker.noteWorkingStart(slug);
      }
      lanes.put(slug, {
        column: 'forge', owner: 'forge', model: result.model, context: result.context,
        verdict: result.verdict, ...(started ? { session_id: started } : {}),
      });
      // 0 done, 1 refused (handled above, before a worker ever ran), 2 parked, 3
      // exhausted, stopped or unverified: every one of those is "not proven done," and a
      // caller scripting off the exit code should never have to parse a verdict string to
      // tell them apart from 0.
      const exitCode = result.verdict === 'done' ? 0 : result.verdict === 'parked' ? 2 : 3;
      return {
        code: exitCode,
        lines: [
          `${slug} ${result.verdict} on ${result.model}, ${result.turns} turn(s), `
            + `${result.sessions.length} session(s), ${result.handoffs} handoff(s)`,
          configDirLine,
        ],
      };
    }

    case 'send': {
      const [run, ...text] = rest;
      if (!run || !text.length) return { code: 2, lines: ['forge send needs a run and text'] };
      new RunInbox(run).send(text.join(' '), 'console');
      return { code: 0, lines: [`queued for ${run}`] };
    }

    case 'answer': {
      const [key, ...answer] = rest;
      if (!key || !answer.length) {
        return { code: 2, lines: ['forge answer needs a key and an answer'] };
      }
      const answerText = answer.join(' ');
      const answered = inbox.answer(key, answerText);
      if (!answered) return { code: 1, lines: [`nothing asked ${key}`] };
      // A run this process itself holds the live session for (deps.engine, injected by a
      // specimen or by `forge run` calling straight through) is answered in place. Every
      // run also gets its answer queued through the inbox, which is what reaches a run
      // this process cannot see directly: another `forge run` process, or a segment that
      // has already ended.
      const { delivered } = await deliverAnswer(
        answered, key, answerText, deps.engine instanceof SdkEngine ? deps.engine : undefined,
      );
      return {
        code: 0,
        lines: [
          `answered ${key}; ${answered.runs.join(', ')} can resume`,
          delivered.length ? `delivered in place to: ${delivered.join(', ')}` : 'queued for pickup on next tool call',
        ],
      };
    }

    case 'decide': {
      const [run, action, ...reasonWords] = rest;
      if (!run || action !== 'kill' || !reasonWords.length) {
        return { code: 2, lines: ['forge decide RUN kill "<reason>" is the only form'] };
      }
      const journal = new Journal(journalPath());
      const decision = journal.append({
        event: 'decision.made', run, actor: 'aaron', action, reason: reasonWords.join(' '),
      });
      journal.close();
      return { code: 0, lines: [`decision ${decision.id} recorded: kill ${run}`] };
    }

    case 'stop': {
      if (!rest.includes('--all')) {
        return { code: 2, lines: ['forge stop --all is the only form; it parks everything'] };
      }
      const reason = rest.filter((word) => word !== '--all').join(' ') || 'stopped by hand';
      const stopRegistry = new Registry(registryDir());
      const { stopped, stale } = await new Fleet(
        lanes, stopRegistry, journalPath(), killSwitchPath(),
      ).stopAll(reason);
      const killSwitchLine = 'the kill switch is set: no new launch starts until '
        + 'forge clear --all';
      if (!stopped.length && !stale.length) {
        return { code: 0, lines: ['nothing was running', killSwitchLine] };
      }
      const reachedCount = stopped.filter((lane) => lane.reached).length;
      return {
        code: 0,
        lines: [
          `parked ${stopped.length} run(s) with a handoff; reached ${reachedCount}, `
            + `unreachable ${stopped.length - reachedCount}`
            + `${stale.length ? `, ${stale.length} stale` : ''}; ${killSwitchLine}`,
          ...stopped.map((lane) => `  ${lane.reached ? 'reached' : 'unreachable'}  ${lane.slug}`),
          ...stale.map((goal) => `  stale       ${goal}`),
        ],
      };
    }

    case 'gotchas': {
      const filed = new Gotchas(gotchasDir(), journalPath()).all();
      return {
        code: 0,
        lines: filed.length
          ? filed.map((g) => `${g.lane.padEnd(6)} ${String(g.hits).padStart(3)}x  ${g.what}`)
          : ['no gotchas filed'],
      };
    }

    case 'clear': {
      const slug = rest[0];
      if (!slug) return { code: 2, lines: ['forge clear needs a lane or --all'] };
      if (slug === '--all') {
        clearKillSwitch(killSwitchPath());
        // F3: an ask whose every run is gone stays open forever, with nothing left to
        // resume if it were answered. `--all` retires each one under `~/.forge/inbox/
        // retired/` rather than deleting it, and journals `inbox.retired` with the key
        // and the runs that asked it, so the question survives even once it is off the
        // open list.
        const clearRegistry = new Registry(registryDir());
        const hasRegistryRow = (run: string): boolean => Boolean(clearRegistry.get(run));
        const staleKeys = inbox.open()
          .filter((entry) => isAskStale(entry, hasRegistryRow))
          .map((entry) => entry.key);
        let retired = 0;
        for (const key of staleKeys) {
          const entry = inbox.retire(key);
          if (!entry) continue;
          retired += 1;
          const retireJournal = new Journal(journalPath());
          try {
            retireJournal.append({ event: 'inbox.retired', actor: 'forge', key, runs: entry.runs });
          } finally {
            retireJournal.close();
          }
        }
        return {
          code: 0,
          lines: [
            'kill switch cleared; forge run may start again',
            retired
              ? `retired ${retired} stale inbox ask${retired === 1 ? '' : 's'}`
              : 'no stale inbox asks found',
          ],
        };
      }
      if (slug === '--stale') {
        // Item 4, 2026-09-05: a lane file outlives the chain it describes -- `forge run`
        // writes it once at admission and again when the chain finishes, and nothing
        // ever removes it after that. A lane whose chain finished (it carries a
        // `verdict`) more than a day ago, and whose registry row is gone (so nothing is
        // still tracking it as live or crashed-and-resumable), is stale and safe to
        // delete outright.
        const staleRegistry = new Registry(registryDir());
        const staleLanes = new Lanes(lanesDir());
        let removed = 0;
        for (const lane of staleLanes.all()) {
          if (!lane.verdict) continue;
          if (staleRegistry.get(lane.slug)) continue;
          const mtime = staleLanes.mtimeOf(lane.slug);
          if (mtime === undefined || Date.now() - mtime < STALE_LANE_MS) continue;
          staleLanes.remove(lane.slug);
          removed += 1;
        }
        if (removed > 0) {
          const clearJournal = new Journal(journalPath());
          try {
            clearJournal.append({ event: 'lanes.cleared', actor: 'forge', count: removed });
          } finally {
            clearJournal.close();
          }
        }
        return {
          code: 0,
          lines: [removed
            ? `removed ${removed} stale lane${removed === 1 ? '' : 's'}`
            : 'no stale lanes found'],
        };
      }
      if (slug === '--phantoms') {
        // I11: `runs/pid_N/` directories the Warden used to write for a fleet process
        // that was never a registered run. A live pid never reaches this -- only names
        // matching `pid_<digits>` with no matching registry row are removed.
        const phantomRegistry = new Registry(registryDir());
        const dir = runsDir();
        let removed = 0;
        if (existsSync(dir)) {
          for (const name of readdirSync(dir)) {
            const match = /^pid_(\d+)$/.exec(name);
            if (!match) continue;
            if (phantomRegistry.get(`pid:${match[1]}`)) continue;
            rmSync(join(dir, name), { recursive: true, force: true });
            removed += 1;
          }
        }
        if (removed > 0) {
          const clearJournal = new Journal(journalPath());
          try {
            clearJournal.append({ event: 'phantoms.cleared', actor: 'warden', count: removed });
          } finally {
            clearJournal.close();
          }
        }
        return {
          code: 0,
          lines: [removed
            ? `removed ${removed} phantom run director${removed === 1 ? 'y' : 'ies'}`
            : 'no phantom run directories found'],
        };
      }
      new Breaker(lanes).clear(slug);
      return { code: 0, lines: [`${slug} may be relaunched again`] };
    }

    case 'cutover': {
      const fromIndex = rest.indexOf('--from');
      const from = fromIndex >= 0 ? rest[fromIndex + 1] : process.env['FORGE_COORDINATION_DIR'];
      if (!from) {
        return {
          code: 2,
          lines: ['forge cutover needs --from DIR, or FORGE_COORDINATION_DIR set in the environment'],
        };
      }
      const dateStr = new Date().toISOString().slice(0, 10);
      const retiredDir = join(forgeHome(), 'retired', dateStr);
      const journal = new Journal(journalPath());
      let result: ReturnType<typeof runCutover>;
      try {
        result = runCutover({ from, retiredDir, processList: readProcessList() }, journal);
      } finally {
        journal.close();
      }
      if (!result.ok) return { code: 1, lines: [`refusing to cut over: ${result.refusal}`] };
      return {
        code: 0,
        lines: result.moved.length
          ? [`retired ${result.moved.length} file(s) to ${retiredDir}`, ...result.moved.map((f) => `  ${f}`)]
          : ['nothing to retire'],
      };
    }

    case 'intake': {
      // J4: the cheapest possible proof a Jira credential works, run the moment it
      // exists. Prints exactly displayName and accountId on success; on failure, the
      // HTTP status and nothing else.
      if (rest.includes('--probe-jira')) {
        const missing = JIRA_ENV_VARS.filter((name) => !process.env[name]);
        if (missing.length) {
          return { code: 1, lines: [`probe failed: missing ${missing.join(', ')}`] };
        }
        const probe = await probeJira({
          site: process.env['FORGE_JIRA_SITE']!, email: process.env['FORGE_JIRA_EMAIL']!,
          token: process.env['FORGE_JIRA_TOKEN']!, fetchFn: deps.fetchFn,
        });
        if (!probe.ok) return { code: 1, lines: [`probe failed: ${probe.status}`] };
        return { code: 0, lines: [probe.displayName ?? '', probe.accountId ?? ''] };
      }

      if (rest.includes('--once')) {
        // P4.7/I5: `forge intake --once`, exported so the console's router (cut 2) calls
        // the same function rather than a second copy of this wiring. J1 wires a real
        // Jira feed once FORGE_JIRA_SITE/EMAIL/TOKEN are all set; every other source
        // still has no real client, so a real run without a specimen's `intakeFeeds`
        // override polls Jira alone, or nothing at all, and says so honestly rather than
        // fabricating a client this codebase has not built.
        let missingJiraLine: string | undefined;
        const feeds = deps.intakeFeeds ?? (() => {
          const missing = JIRA_ENV_VARS.filter((name) => !process.env[name]);
          if (missing.length) {
            missingJiraLine = `jira not configured: missing ${missing.join(', ')}`;
            return [];
          }
          return [createJiraFeed({
            site: process.env['FORGE_JIRA_SITE']!, email: process.env['FORGE_JIRA_EMAIL']!,
            token: process.env['FORGE_JIRA_TOKEN']!, jql: process.env['FORGE_JIRA_JQL'],
            fetchFn: deps.fetchFn,
          })];
        })();
        const intakeJournal = new Journal(journalPath());
        let result: Awaited<ReturnType<typeof runIntakeOnce>>;
        let plannedLine: string | undefined;
        try {
          result = await runIntakeOnce(
            feeds,
            {
              get: (source) => readWatermark(source),
              set: (source, mark) => writeWatermark(source, mark),
            },
            (event) => intakeJournal.append({ actor: 'intake', ...event }),
            undefined,
            // R1: the launch line, never a tracked file, carries the map. No map or no
            // match leaves a packet's repository 'unknown', printed below so an operator
            // knows what to add.
            parseRepoMap(process.env['FORGE_INTAKE_REPO_MAP']),
          );
          // forge-council-live, work item 3: one queued packet through the planner,
          // best-effort. A Reasoner failure here must not turn an honest zero-feed or
          // fixture-only poll into a crash for the whole `--once` run.
          if (result.writtenPackets.length) {
            const packet = result.writtenPackets[0]!;
            const provider = resolvePlanProvider(loadPolicy().reasoner);
            const plannerReasoner = reasonerFor(provider, { journal: intakeJournal, queryFn: deps.reasonerQueryFn });
            try {
              const planned = await planFromPacket(packet, plannerReasoner);
              const briefsDir = intakeBriefsDir();
              mkdirSync(briefsDir, { recursive: true });
              const briefPath = join(briefsDir, `${planned.packetId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
              writeFileSync(briefPath, planned.text, 'utf8');
              intakeJournal.append({
                event: 'intake.planned', actor: 'intake', ticket: planned.ticket,
                packetId: planned.packetId, briefPath,
              });
              plannedLine = `planned a brief for ${planned.ticket}: ${briefPath}`;
            } catch (error) {
              plannedLine = `planning failed for ${packet.ticket}: `
                + `${error instanceof Error ? error.message : String(error)}`;
            }
          }
        } finally {
          intakeJournal.close();
        }
        return {
          code: 0,
          lines: [
            `polled ${result.sourcesPolled.length} source(s): `
              + `${result.sourcesPolled.join(', ') || '(none configured)'}`,
            `observed ${result.observed}, wrote ${result.packetsWritten} packet(s), `
              + `raised ${result.intentsRaised} external intent(s)`,
            ...(missingJiraLine ? [missingJiraLine] : []),
            ...result.unrouted.map((u) => `unrouted ${u.ticket}: labels=[${u.labels.join(', ')}], `
              + `components=[${u.components.join(', ')}]`),
            ...(plannedLine ? [plannedLine] : []),
          ],
        };
      }
      if (!rest.includes('--dry-run')) {
        return {
          code: 2,
          lines: [
            'forge intake --dry-run | --once are the only forms today: decision 1\'s '
              + 'Jira token does not exist yet, so nothing here ever performs a live write',
          ],
        };
      }
      // No fixture wired to the CLI yet (P4.7 integration point): an empty run is an
      // honest "nothing to do" rather than a fabricated example write.
      return { code: 0, lines: planIntakeWrites([]) };
    }

    case 'queue': {
      const sub = rest[0];
      if (sub === 'add') {
        const input = rest[1];
        if (!input) return { code: 2, lines: ['forge queue add INPUT [--source ticket|brief|hotfix|goal]'] };
        const sourceFlag = rest.indexOf('--source');
        const explicitSource = sourceFlag >= 0 ? rest[sourceFlag + 1] : undefined;
        // 2026-09-08: an existing .md file that carries a sibling .block.txt, an
        // inline /goal line, or a fenced goal-spec block auto-detects as `goal`
        // before falling to the plain `brief` file-read source.
        const source = explicitSource
          ?? (TICKET_KEY_RE.test(input)
            ? 'ticket'
            : /\.md$/i.test(input) && isExistingFile(input) && isGoalFile(input)
              ? 'goal'
              : isExistingFile(input) ? 'brief' : undefined);
        if (!source) {
          return {
            code: 1,
            lines: [`refusing to queue "${input.slice(0, 60)}": it is not a ticket key like `
              + 'ABC-123, and not a path to an existing file. Pass --source to force one.'],
          };
        }
        const added = await serverRequest('/queue', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source, input }),
        }, deps.fetchFn);
        if (added.down) return { code: 1, lines: [added.error!] };
        const body = added.body as { ok: boolean; items?: Array<{ id: string; state: string }>; error?: string } | undefined;
        if (!added.ok || !body?.ok) {
          return { code: 1, lines: [body?.error ?? `queue add failed: HTTP ${added.status}`] };
        }
        return {
          code: 0,
          lines: (body.items ?? []).map((item) => `${item.id} ${item.state}`),
        };
      }
      if (sub === 'ls') {
        const stateFlag = rest.indexOf('--state');
        const stateFilter = stateFlag >= 0 ? rest[stateFlag + 1] : undefined;
        const wantsJson = rest.includes('--json');
        const wantsAll = rest.includes('--all');
        const listed = await serverRequest('/queue', {}, deps.fetchFn);
        if (listed.down) return { code: 1, lines: [listed.error!] };
        const body = listed.body as {
          items?: Array<{
            id: string; source: string; ticket: string | null; input: string; state: string;
            branch: string | null; pr: { url: string } | null; reason: string | null;
            title?: string | null;
          }>;
        } | undefined;
        if (!listed.ok || !body) return { code: 1, lines: [`queue ls failed: HTTP ${listed.status}`] };
        let items = body.items ?? [];
        if (stateFilter) items = items.filter((item) => item.state === stateFilter);
        else if (!wantsAll) items = items.filter((item) => item.state !== 'done');
        if (wantsJson) return { code: 0, lines: [JSON.stringify(items)] };
        if (!items.length) return { code: 0, lines: ['nothing queued'] };
        return {
          code: 0,
          lines: items.map((item) => [
            item.id,
            item.source.padEnd(6),
            // `input` is a brief's whole markdown text: naming the item beats printing
            // the first 40 characters of its front matter.
            (item.title ?? item.ticket ?? item.id).slice(0, 40).padEnd(40),
            item.state.padEnd(9),
            (item.branch ?? '-').padEnd(20),
            item.pr?.url ?? '-',
            (item.reason ?? '').slice(0, 120),
          ].join(' ')),
        };
      }
      return { code: 2, lines: ['forge queue add INPUT | forge queue ls [--state S] [--json] [--all]'] };
    }

    case 'rounds': {
      const ROUNDS_TIMEOUT_MS = 60_000;
      const apply = rest.includes('--apply');
      const wantsJson = rest.includes('--json');
      // A walk reads the blocker board, which shells out to gh per repo; the default
      // ten-second ceiling is for routes that answer from memory.
      const result = await serverRequest(apply ? '/rounds/apply' : '/rounds', apply ? { method: 'POST' } : {}, deps.fetchFn, ROUNDS_TIMEOUT_MS);
      if (result.down) return { code: 1, lines: [result.error!] };
      const body = result.body as { lines?: string[]; error?: string } | undefined;
      if (!result.ok || !body) return { code: 1, lines: [body?.error ?? `rounds failed: HTTP ${result.status}`] };
      if (wantsJson) return { code: 0, lines: [JSON.stringify(result.body)] };
      return { code: 0, lines: body.lines ?? [] };
    }
    case 'inbox': {
      const missing = JIRA_ENV_VARS.filter((name) => !process.env[name]);
      if (missing.length) return { code: 1, lines: [`inbox failed: missing ${missing.join(', ')}`] };
      const daysFlag = rest.indexOf('--days');
      const days = daysFlag >= 0 ? Number(rest[daysFlag + 1]) : 7;
      const wantsJson = rest.includes('--json');
      const fetched = await fetchInboxIssues({
        site: process.env['FORGE_JIRA_SITE']!, email: process.env['FORGE_JIRA_EMAIL']!,
        token: process.env['FORGE_JIRA_TOKEN']!, days, fetchFn: deps.fetchFn,
      });
      const probe = await probeJira({
        site: process.env['FORGE_JIRA_SITE']!, email: process.env['FORGE_JIRA_EMAIL']!,
        token: process.env['FORGE_JIRA_TOKEN']!, fetchFn: deps.fetchFn,
      });
      if (!probe.ok) return { code: 1, lines: [`inbox failed: could not identify the current user (HTTP ${probe.status})`] };
      const buckets = classifyInbox(fetched, { accountId: probe.accountId ?? '' }, Date.now());
      if (wantsJson) return { code: 0, lines: [JSON.stringify(buckets)] };
      const lines: string[] = [];
      const section = (title: string, rows: typeof buckets.needsReply) => {
        lines.push(`${title} (${rows.length})`);
        for (const row of rows) {
          lines.push(`  ${row.key.padEnd(10)} ${row.status.padEnd(14)} ${(row.assignee ?? '-').padEnd(18)} `
            + `${(row.lastCommenter ?? '-').padEnd(18)} ${String(row.ageDays).padStart(3)}d  ${row.summary.slice(0, 60)}`);
        }
      };
      section('needs reply', buckets.needsReply);
      section('awaiting others', buckets.awaitingOthers);
      section('status drift', buckets.statusDrift);
      return { code: 0, lines };
    }

    case 'council': {
      const repoFlag = rest.indexOf('--repo');
      const prFlag = rest.indexOf('--pr');
      const cwdFlag = rest.indexOf('--cwd');
      const baseFlag = rest.indexOf('--base');
      const repo = repoFlag >= 0 ? rest[repoFlag + 1] : undefined;
      const prRaw = prFlag >= 0 ? rest[prFlag + 1] : undefined;
      const pr = prRaw ? Number.parseInt(prRaw, 10) : NaN;
      const councilCwd = cwdFlag >= 0 ? rest[cwdFlag + 1] : undefined;
      const councilBaseRef = baseFlag >= 0 ? rest[baseFlag + 1] : undefined;
      if (!repo || !Number.isFinite(pr)) {
        return { code: 2, lines: ['forge council --repo OWNER/NAME --pr N [--base BRANCH] [--cwd PATH]'] };
      }

      const policy = councilPolicy();
      if (!repoAllowedForCouncil(repo, policy)) {
        return {
          code: 2,
          lines: [`refused: ${repo} is not on council's review allow-list -- set `
            + 'FORGE_COUNCIL_REPOS (comma-separated) or model-policy.json\'s council.allowedRepos'],
        };
      }

      const gh = deps.councilGh ?? REAL_GH;
      const snapshot = await gh.viewPr(repo, pr);

      if (snapshot.checks.conclusion !== 'success') {
        // BBZ-60/62/74/202, 2026-09-08: `pending` is "not yet", never "no" -- a queued or
        // in-progress check almost always turns green on its own. Marking it on `data`
        // lets `chainCouncil` and the queue's `advanceItem` retry instead of parking,
        // without either of them string-matching this line.
        return {
          code: 2,
          lines: [`refused: checks are ${snapshot.checks.conclusion} on head `
            + `${snapshot.headSha}, not green`],
          ...(snapshot.checks.conclusion === 'pending' ? { data: { pending: true } } : {}),
        };
      }

      const councilJournal = new Journal(journalPath());
      try {
        const reasoner = reasonerFor('claude', { journal: councilJournal, queryFn: deps.reasonerQueryFn });
        const ruleVerdict = evaluateAction({
          kind: 'pr', op: 'merge', repo, title: snapshot.title, body: snapshot.body, cwd: process.cwd(),
        });
        // Rival account 3 (2026-09-07 plan): the chain sets `deps.forceCodexLane` itself
        // from `FORGE_COUNCIL_CODEX=always`, but a bare hand-typed `forge council` never
        // read the environment variable at all -- it only ever saw whatever `deps`
        // supplied. Falling back to the env var here is what makes the CLI case honour
        // the same setting the chain already did.
        const forceCodexLane = deps.forceCodexLane ?? process.env['FORGE_COUNCIL_CODEX'] === 'always';
        // Item 7, 2026-09-05: the PR this round is reasoning about, so a reasoner spend
        // for either role attributes back to it rather than showing up as unattributed
        // cost on the fleet's burn ledger.
        const councilRun = `${repo}#${pr}`;
        const roles = {
          lensRunner: reasonerLensRunner(reasoner, [ruleVerdict], councilRun),
          codexLane: codexLaneFor(
            forceCodexLane ? { ...policy, codex: 'on' } : policy,
            { journal: councilJournal, run: councilRun },
          ),
          judge: reasonerJudge(reasoner, councilRun),
        };

        // I19: a lens's own reply failure (unparseable JSON, prose, or anything else
        // `reasonerLensRunner` cannot make sense of) never reaches here as a rejection --
        // it is already folded into a `failed: true` lens report. What can still throw at
        // this point is the judge (or, when `council.codex` is `on`, the Codex lane)
        // genuinely failing to answer at all, which is a different condition from any
        // verdict the judge could actually reach: the round produced nothing to attest,
        // rather than a verdict of FIX FIRST.
        let round: Awaited<ReturnType<typeof runCouncilRound>>;
        try {
          round = await runCouncilRound(
            {
              brief: snapshot.body, diffSummary: snapshot.diffText, changedLines: snapshot.changedLines,
              paths: snapshot.files, ci: { runId: snapshot.checks.runId, headSha: snapshot.checks.headSha },
              cwd: councilCwd, baseRef: councilBaseRef,
              ...(forceCodexLane ? { forceCodex: true } : {}),
            },
            roles,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          councilJournal.append({
            event: 'council.judge', actor: 'council', repo, pr, verdict: 'unavailable', error: redact(message),
          });
          return { code: 1, lines: [`refused: the judge could not produce a verdict: ${redact(message)}`] };
        }

        for (const report of round.lensReports) {
          councilJournal.append({
            event: 'council.lens', actor: 'council', repo, pr, lens: report.lens,
            findings: report.findings.length,
            ...(report.retried ? { retried: true } : {}),
            ...(report.failed
              ? {
                  failed: true,
                  error: `lens ${report.lens} returned an unparseable reply`,
                  raw: report.rawReply !== undefined ? redact(report.rawReply) : undefined,
                }
              : {}),
          });
        }
        councilJournal.append({ event: 'council.judge', actor: 'council', repo, pr, verdict: round.verdict });

        // A round can take real model time. Re-read the head right before the
        // attestation is written -- a head that moved mid-round must never be
        // attested against (acceptance specimen: a moved head yields exit 2).
        const confirm = await gh.viewPr(repo, pr);
        if (confirm.headSha !== snapshot.headSha) {
          return {
            code: 2,
            lines: [`refused: head moved from ${snapshot.headSha} to ${confirm.headSha} `
              + 'while the council was running'],
          };
        }

        const findingLines = [...round.decidingFindings]
          .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
          .map((f) => `  [${f.severity}/${f.confidence}] ${f.file}:${f.line} -- ${f.claim}`);

        // GATE.md item 4: a member missing from this round is on the board, not only
        // recoverable by reading a file -- `coverageNote` reaches `forge council`'s own
        // `data`, which `chain-wire.ts`'s `chainCouncil` and the queue's `advanceItem`
        // read to name the gap in a parked item's own reason, and `coverage` below lands
        // on the attestation itself for a round that did clear.
        const membersRan = round.membersTotal - round.missingMembers.length;
        const coverageNote = round.missingMembers.length
          ? `reviewed by ${membersRan} of ${round.membersTotal} (missing: ${round.missingMembers.join(', ')})`
          : undefined;

        // FIX FIRST re-enters the worker (`rounds.ts`'s own state machine) rather than
        // clearing the gate; an attestation exists only for a verdict that could ever
        // clear it, so a FIX FIRST round writes none (acceptance specimen: exit 1, no
        // attestation file).
        if (round.verdict === 'FIX FIRST') {
          return {
            code: 1,
            lines: [
              `verdict: ${round.verdict}`,
              ...(findingLines.length ? findingLines : ['no deciding findings']),
            ],
            data: { verdict: round.verdict, ...(coverageNote ? { coverageNote } : {}) },
          };
        }

        const attestation: CouncilAttestation = {
          repo, pr, head: snapshot.headSha, base: snapshot.baseSha, round: 1,
          verdict: round.verdict, decidingFindings: round.decidingFindings, lenses: round.lensReports,
          ...(round.codexRan ? { codex: { ran: true, findings: round.codexOnly } } : {}),
          judge: { model: modelIdFor(modelFor('audit-judge')), verdict: round.verdict },
          ci: { runId: snapshot.checks.runId, headSha: snapshot.checks.headSha },
          at: verified(Date.now(), 'gh pr view'),
          coverage: { total: round.membersTotal, missing: round.missingMembers },
        };
        const attPath = writeAttestation(attestation);
        councilJournal.append({
          event: 'council.attested', actor: 'council', repo, pr, head: snapshot.headSha,
          verdict: round.verdict, path: attPath,
        });

        // BBZ-123: the terminal once printed `round.verdict` while the attestation on
        // disk carried a different one (PR #123, 2026-09-08 -- an operator watching the
        // console would have believed the council failed while it had actually cleared
        // and the gate went on to merge). Reading the just-written file back is the one
        // way the printed line can never diverge from what `forge gate` will later read:
        // there is no second copy of the verdict left to drift.
        const attested = readAttestation(repo, pr, snapshot.headSha) ?? attestation;
        const attestedFindingLines = [...attested.decidingFindings]
          .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
          .map((f) => `  [${f.severity}/${f.confidence}] ${f.file}:${f.line} -- ${f.claim}`);

        return {
          code: 0,
          lines: [
            `verdict: ${attested.verdict}`,
            ...(attestedFindingLines.length ? attestedFindingLines : ['no deciding findings']),
            `attestation: ${attPath}`,
          ],
          data: { verdict: attested.verdict, attestationPath: attPath, ...(coverageNote ? { coverageNote } : {}) },
        };
      } finally {
        councilJournal.close();
      }
    }

    case 'gate': {
      const repoFlag = rest.indexOf('--repo');
      const prFlag = rest.indexOf('--pr');
      const handoffFlag = rest.indexOf('--handoff');
      const merge = rest.includes('--merge');
      const repo = repoFlag >= 0 ? rest[repoFlag + 1] : undefined;
      const prRaw = prFlag >= 0 ? rest[prFlag + 1] : undefined;
      const pr = prRaw ? Number.parseInt(prRaw, 10) : NaN;
      if (!repo || !Number.isFinite(pr)) {
        return { code: 2, lines: ['forge gate --repo OWNER/NAME --pr N [--merge] [--handoff FILE]'] };
      }

      const gh = deps.councilGh ?? REAL_GH;
      const snapshot = await gh.viewPr(repo, pr);
      const attestation = readAttestation(repo, pr, snapshot.headSha);

      if (!attestation) {
        return {
          code: 1,
          lines: [`refused: no attestation for ${repo}#${pr} at head ${snapshot.headSha} -- `
            + 'run forge council first'],
        };
      }
      if (!attestationCoversHead(attestation, { head: snapshot.headSha, base: snapshot.baseSha })) {
        return {
          code: 1,
          lines: [`refused: the attestation is for head ${attestation.head}/base ${attestation.base}, `
            + `the PR's current head/base is ${snapshot.headSha}/${snapshot.baseSha}`],
        };
      }
      if (attestation.verdict === 'FIX FIRST') {
        return { code: 1, lines: [`refused: the attestation's verdict is ${attestation.verdict}`] };
      }
      if (snapshot.checks.headSha !== snapshot.headSha || snapshot.checks.conclusion !== 'success') {
        return {
          code: 1,
          lines: [`refused: checks are ${snapshot.checks.conclusion} on head ${snapshot.checks.headSha}`],
          ...(snapshot.checks.conclusion === 'pending' ? { data: { pending: true } } : {}),
        };
      }

      // Haiping (QA) only ever looks at a `frontend`-kind repo. A backend repo or the
      // self repo has nobody to hand a visual plan to, so demanding one here bought
      // nothing but a `REPLACE:`-riddled block pasted to satisfy the schema (PRs
      // #79/#83) or a merge stuck on review with no handoff to write (PR #82).
      const chainEnv = readChainEnv();
      const isSelf = (process.env['FORGE_SELF_REPO'] ?? '').trim() === repo;
      const needsHaipingHandoff = !isSelf && repoKindFor(chainEnv, repo) === 'frontend';

      let haiping: HaipingHandoff | undefined;
      if (needsHaipingHandoff) {
        const handoffFile = handoffFlag >= 0 ? rest[handoffFlag + 1] : undefined;
        if (handoffFile) {
          try {
            const parsed = JSON.parse(readFileSync(handoffFile, 'utf8'));
            haiping = checkHandoff('haiping', parsed).complete ? (parsed as HaipingHandoff) : undefined;
          } catch {
            haiping = undefined;
          }
        } else {
          haiping = findHaipingHandoff(snapshot.body);
        }

        if (!haiping) {
          return {
            code: 1,
            lines: ['refused: no complete Haiping handoff found in the PR body or --handoff file'],
          };
        }
      }

      if (!merge) {
        return {
          code: 0,
          lines: [`gate: PASS -- ${repo}#${pr} at ${snapshot.headSha} clears (${attestation.verdict})`],
          data: { merged: false },
        };
      }

      const policy = councilPolicy();
      if (!autoMergeAllowed(repo, policy)) {
        const joe: JoeHandoff = {
          ticket: `${repo}#${pr}`, draftPr: `${repo}#${pr}`, packets: attestation.lenses,
          howToRun: 'see the PR body for verification commands', couldNotRun: [],
        };
        return {
          code: 3,
          lines: [`${repo} is not on council.autoMerge: leaving the draft PR for Joe`, JSON.stringify(joe)],
          data: { merged: false },
        };
      }

      const gateJournal = new Journal(journalPath());
      try {
        // F5: `gh pr merge` refuses outright on a draft PR and nothing here ever read
        // `isDraft` to see it coming. A passing gate is by construction what makes a
        // draft ready, so a merge decision on a draft marks it ready first, journaled
        // as its own external.intent/external.call of kind pr-ready.
        if (snapshot.isDraft) {
          let readyWrite = planReadyIntent({ repo, pr, headSha: snapshot.headSha });
          gateJournal.append({
            event: 'external.intent', actor: 'council', kind: readyWrite.kind,
            idempotencyKey: readyWrite.idempotencyKey,
          });
          readyWrite = recordMergeCall(readyWrite);
          gateJournal.append({
            event: 'external.call', actor: 'council', kind: readyWrite.kind,
            idempotencyKey: readyWrite.idempotencyKey,
          });
          const readyResult = await gh.readyPr(repo, pr);
          if (readyResult.returncode !== 0) {
            const stderr = readyResult.stderr.slice(0, 300);
            gateJournal.append({
              event: 'external.unknown', actor: 'council', kind: readyWrite.kind,
              idempotencyKey: readyWrite.idempotencyKey, state: 'unknown',
              exitCode: readyResult.returncode, stderr,
            });
            return {
              code: 1,
              lines: [`ready unknown: ${repo}#${pr} (exit ${readyResult.returncode}): ${stderr}`],
            };
          }
          gateJournal.append({
            event: 'external.complete', actor: 'council', kind: readyWrite.kind,
            idempotencyKey: readyWrite.idempotencyKey,
          });
        }

        const subject = `${snapshot.title} (#${pr})`;
        const body = redactPrBody(snapshot.body);
        const call = buildSquashMergeCall({ commits: [], subject, body });

        let write = planMergeIntent({ repo, pr, headSha: snapshot.headSha });
        gateJournal.append({
          event: 'external.intent', actor: 'council', kind: write.kind, idempotencyKey: write.idempotencyKey,
        });

        write = recordMergeCall(write);
        gateJournal.append({
          event: 'external.call', actor: 'council', kind: write.kind, idempotencyKey: write.idempotencyKey,
        });
        const mergeResult = await gh.mergePr(repo, pr, call.subject, call.body);

        const view = await gh.viewPrState(repo, pr);
        write = reconcileMerge(write, view);
        // F5: an unknown outcome used to carry nothing beyond the word "unknown" -- the
        // exit code and (truncated) stderr are what tell the operator why, rather than
        // sending them back to read the raw gh call by hand.
        const mergeStderr = mergeResult.stderr.slice(0, 300);
        gateJournal.append({
          event: write.state === 'complete' ? 'external.complete' : 'external.unknown',
          actor: 'council', kind: write.kind, idempotencyKey: write.idempotencyKey, state: write.state,
          ...(write.state === 'unknown' ? { exitCode: mergeResult.returncode, stderr: mergeStderr } : {}),
        });

        const lines = [write.state === 'complete'
          ? `merge ${write.state}: ${repo}#${pr}`
          : `merge ${write.state}: ${repo}#${pr} (exit ${mergeResult.returncode}): ${mergeStderr}`];

        // J3: once the merge itself is complete and the handoff names a ticket, post
        // the QA handoff to Jira. A Jira failure never fails the merge -- the row above
        // already stands as `complete` -- so every branch here only ever adds lines and
        // journal rows, never changes `code`.
        if (write.state === 'complete' && haiping?.ticket) {
          const missingJira = JIRA_ENV_VARS.filter((name) => !process.env[name]);
          if (missingJira.length) {
            gateJournal.append({
              event: 'jira.skipped', actor: 'council', ticket: haiping.ticket,
              reason: `missing ${missingJira.join(', ')}`,
            });
            lines.push(`jira skipped: missing ${missingJira.join(', ')}`);
          } else {
            const jiraClient = deps.jiraWrite ?? createJiraWriteClient({
              site: process.env['FORGE_JIRA_SITE']!, email: process.env['FORGE_JIRA_EMAIL']!,
              token: process.env['FORGE_JIRA_TOKEN']!, fetchFn: deps.fetchFn,
            });
            const prUrl = `https://github.com/${repo}/pull/${pr}`;
            const jiraLines = await runJiraHandoff(
              jiraClient, haiping, snapshot.headSha, prUrl,
              {
                qaAccountId: process.env['FORGE_JIRA_QA_ACCOUNT'],
                qaTransitionId: process.env['FORGE_JIRA_QA_TRANSITION'],
              },
              (event) => gateJournal.append({ actor: 'council', ...event }),
            );
            lines.push(...jiraLines);
          }
        }

        return {
          code: write.state === 'complete' ? 0 : 1,
          lines,
          data: {
            merged: write.state === 'complete',
            ...(view.mergeCommitOid ? { mergeSha: view.mergeCommitOid } : {}),
          },
        };
      } finally {
        gateJournal.close();
      }
    }

    case 'chain': {
      const [sub, ...chainArgs] = rest;

      if (!sub) {
        const state = foldChainState(replay(journalPath()).events);
        const chainRows = chainStatusLines(state);
        return { code: 0, lines: chainRows.length ? chainRows : ['no packets in the chain'] };
      }

      if (sub === 'retry') {
        const [packetId, ...reasonArgs] = chainArgs;
        if (!packetId) return { code: 2, lines: ['forge chain retry needs a packet id'] };

        const journalState = replay(journalPath());
        const state = foldChainState(journalState.events);
        const row = state.get(packetId);
        if (!row) return { code: 2, lines: [`unknown packet ${packetId}`] };

        const reasonFlag = reasonArgs.indexOf('--reason');
        const reason = reasonFlag >= 0 ? reasonArgs.slice(reasonFlag + 1).join(' ') : undefined;

        // E3, 2026-09-05: a packet whose last chain row is `chain.launched` and whose
        // run has neither a registry row nor a `run.started` row never actually started
        // -- the launch hop is the one worth re-running, not whatever comes after it.
        // A run that did start is refused: `forge stop` is the right tool for that one.
        if (row.launched && !row.blocked && !row.gated && !row.merged && !row.stopped) {
          const runKey = row.launched.runKey;
          const started = hasRunRegistered(runKey, {
            registry: new Registry(registryDir()), events: journalState.events,
          });
          if (started) {
            return {
              code: 2,
              lines: [`${packetId}'s run (${runKey}) already started; run forge stop to stop it instead`],
            };
          }

          const launchRetryJournal = new Journal(journalPath());
          try {
            launchRetryJournal.append({
              event: 'chain.unblocked', actor: 'aaron', packetId, hop: 'launch',
              reason: 'launch never registered',
            });
          } finally {
            launchRetryJournal.close();
          }
          return { code: 0, lines: [`unblocked ${packetId}: launch never registered, will relaunch`] };
        }

        const chainJournal = new Journal(journalPath());
        try {
          chainJournal.append({
            event: 'chain.unblocked', actor: 'aaron', packetId, ...(reason ? { reason } : {}),
          });
        } finally {
          chainJournal.close();
        }
        return { code: 0, lines: [`unblocked ${packetId}`] };
      }

      if (sub === 'skip') {
        const [packetId, ...reasonArgs] = chainArgs;
        if (!packetId) return { code: 2, lines: ['forge chain skip needs a packet id'] };

        const state = foldChainState(replay(journalPath()).events);
        const row = state.get(packetId);
        if (!row) return { code: 2, lines: [`unknown packet ${packetId}`] };
        if (row.launched) {
          return {
            code: 2,
            lines: [`${packetId} is already launched; run forge stop to stop it instead`],
          };
        }

        const reasonFlag = reasonArgs.indexOf('--reason');
        const givenReason = reasonFlag >= 0 ? reasonArgs.slice(reasonFlag + 1).join(' ') : undefined;
        const reason = givenReason ? `skipped: ${givenReason}` : 'skipped';

        const chainJournal = new Journal(journalPath());
        try {
          chainJournal.append({ event: 'chain.stopped', actor: 'aaron', packetId, reason });
        } finally {
          chainJournal.close();
        }
        return { code: 0, lines: [`skipped ${packetId}`] };
      }

      return {
        code: 2,
        lines: [`forge chain [retry PACKET [--reason "<why>"]] | [skip PACKET [--reason "<why>"]] -- `
          + `unknown subcommand ${sub}`],
      };
    }

    case 'reason': {
      // The cheapest possible proof that the `claude` provider reaches a real model:
      // `forge reason --class evaluate '<question>'` prints the JSON answer and the
      // journal row id, on whichever provider `model-policy.json` names for CLASS.
      const classFlag = rest.indexOf('--class');
      const className = classFlag >= 0 ? rest[classFlag + 1] : undefined;
      const prompt = rest
        .filter((_, index) => index !== classFlag && index !== classFlag + 1)
        .join(' ')
        .trim();
      if (!className || !prompt) {
        return {
          code: 2,
          lines: ['forge reason --class CLASS "question" -- CLASS names a model-policy '
            + 'class (evaluate, audit-lens, audit-judge, ...)'],
        };
      }
      const reasonJournalPath = journalPath();
      const reasonJournal = new Journal(reasonJournalPath);
      try {
        const provider = providerFor(className);
        const liveReasoner = reasonerFor(provider, {
          journal: reasonJournal, queryFn: deps.reasonerQueryFn,
        });
        try {
          const result = await liveReasoner.call({ className, prompt });
          const state = replay(reasonJournalPath);
          const row = [...state.events].reverse().find((event) => event.event === 'reasoner.call');
          return {
            code: 0,
            lines: [JSON.stringify({ text: result.text }), `journal row: ${row?.id ?? '(not found)'}`],
          };
        } catch (error) {
          const state = replay(reasonJournalPath);
          const row = [...state.events].reverse()
            .find((event) => event.event === 'reasoner.call' || event.event === 'reasoner.timeout');
          return {
            code: 1,
            lines: [
              `forge reason failed: ${error instanceof Error ? error.message : String(error)}`,
              `journal row: ${row?.id ?? '(not found)'}`,
            ],
          };
        }
      } finally {
        reasonJournal.close();
      }
    }

    default:
      return {
        code: 2,
        lines: [
          'forge up | status | run BRIEF | send RUN TEXT | answer KEY ANSWER | stop --all '
            + '| gotchas | clear LANE | cutover [--from DIR] | intake --dry-run | reason --class CLASS '
            + '| council --repo O/N --pr N | gate --repo O/N --pr N [--merge] [--handoff FILE] '
            + '| chain [retry PACKET [--reason "<why>"]] | [skip PACKET [--reason "<why>"]]',
          `the server listens on ${FORGE_PORT}`,
        ],
      };
  }
}

/* c8 ignore start */
if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  forge(process.argv.slice(2)).then((result) => {
    for (const line of result.lines) process.stdout.write(`${line}\n`);
    process.exitCode = result.code;
  });
}
/* c8 ignore stop */
