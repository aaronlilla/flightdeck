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
 *
 * `stop --all` is the control that has to work when nothing else does, so it takes no
 * arguments it could get wrong, is safe to run twice, and says plainly when there was
 * nothing to stop. It parks rather than kills: the work survives and `forge up` continues
 * it. A stop that lost an afternoon is a stop nobody dares press.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { QueryFn } from '../adapter/engine.js';
import { BlockerBoard } from './blockers.js';
import { readAttestation, writeAttestation } from './council/attest.js';
import { buildSquashMergeCall } from './council/gate.js';
import { planMergeIntent, recordMergeCall, reconcileMerge } from './council/externalize.js';
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
import { runIntakeOnce } from './intake/once.js';
import type { FakePollFeed } from './intake/poller.js';
import { planFromPacket } from './intake/planner.js';
import { resolvePlanProvider } from './intake/reasoner.js';
import { initialWatermark } from './intake/watermark.js';
import { readProcessList, watchedProcesses } from './fleetwatch.js';
import { Gotchas } from './gotcha.js';
import { Inbox } from './inbox.js';
import { replay, Journal, JournalCache } from './journal.js';
import { checkLaunch, launchEnv, loginInFlight, pinnedRuntime, runtimeVersion } from './launcher.js';
import { assess, LivenessSupervisor } from './liveness.js';
import {
  ensureHome, fleetConfigDirChoice, forgeHome, gotchasDir, inboxDir, intakeBriefsDir, journalPath,
  killSwitchPath, lanesDir, registryDir, runsDir,
} from './paths.js';
import { loadPolicy, modelFor, modelIdFor, tierOfBrief } from './policy.js';
import { attestationCoversHead, checkHandoff, providerFor, redact, verified } from './contracts.js';
import type { CouncilAttestation, HaipingHandoff, JoeHandoff } from './contracts.js';
import { evaluateAction } from './rules/index.js';
import { processAlive, reconcileRegistry, Registry } from './registry.js';
import { reasonerFor } from './reasoner-claude.js';
import { deliverAnswer, RunInbox } from './runinbox.js';
import { SdkEngine } from './sdkengine.js';
import { FORGE_PORT, ForgeServer } from './server.js';
import { Breaker, clearKillSwitch, Fleet, Lanes, readKillSwitch } from './supervisor.js';
import { WardenActuator } from './warden.js';
import { WardenTick, type WardenTickRun } from './warden-tick.js';
import { Worker, type EngineLike, type WorkerConfig } from './worker.js';

export interface CliResult {
  code: number;
  lines: string[];
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
}

/** Item 4, 2026-09-05: how old a lane's own file has to be, with no live registry row
 *  behind it, before `forge clear --stale` deletes it and `forge status` stops showing
 *  it by default. */
const STALE_LANE_MS = 24 * 3_600_000;

/**
 * The fleet's process table for `status` and `up`, read through `deps.processes` when a
 * specimen supplies one. `watchedProcesses`'s own parameter defaults to a real
 * `probeProcessList()` call, evaluated fresh each time the argument is left out -- passing
 * `undefined` explicitly here (the production path) hits that same default, so nothing
 * about a real run's behavior changes; passing an injected list instead skips the real
 * probe outright, since a supplied argument always wins over a default one.
 */
function fleetSnapshot(deps: ForgeDeps): ReturnType<typeof watchedProcesses> {
  return watchedProcesses(deps.processes ? { ok: true, lines: deps.processes() } : undefined);
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
function watermarkPath(source: string): string {
  return join(forgeHome(), 'intake', `${source}.watermark.json`);
}

function readWatermark(source: Parameters<typeof initialWatermark>[0]): ReturnType<typeof initialWatermark> {
  try {
    return JSON.parse(readFileSync(watermarkPath(source), 'utf8'));
  } catch {
    return initialWatermark(source);
  }
}

function writeWatermark(source: string, mark: ReturnType<typeof initialWatermark>): void {
  const dir = join(forgeHome(), 'intake');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(watermarkPath(source), JSON.stringify(mark), 'utf8');
}

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
  autoAnswer?: string;
} {
  let dryRun = false;
  let maxContext: number | undefined;
  let maxTurns: number | undefined;
  let invalid: string | undefined;
  let autoAnswer: string | undefined;
  const words: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--dry-run') { dryRun = true; continue; }
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
    dryRun, condition: words.join(' '),
    ...(maxContext !== undefined ? { maxContext } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(autoAnswer !== undefined ? { autoAnswer } : {}),
    ...(invalid ? { invalid } : {}),
  };
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Run one command and say what happened.
 *
 * Returns rather than printing, so the specimens can read the outcome and `main` stays
 * the only place that writes to a terminal.
 */
export async function forge(argv: string[], deps: ForgeDeps = {}): Promise<CliResult> {
  const [command, ...rest] = argv;
  ensureHome();
  const lanes = new Lanes(lanesDir());
  const inbox = new Inbox(inboxDir());

  switch (command) {
    case 'status': {
      const state = replay(journalPath());
      const statusRegistry = new Registry(registryDir());
      const stuckRows = assess({
        now: Date.now(),
        runs: snapshotRuns(state, statusRegistry, deps.alive),
        fleet: fleetSnapshot(deps),
      })
        .filter((trip) => trip.signal !== 'registry-abandoned')
        .map((trip) => `STUCK  ${trip.key.padEnd(24)} ${trip.signal.padEnd(14)} ${trip.hint}`);
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
      const waiting = inbox.open().length;
      // An idle fleet says one thing and stops. Appending "inbox: 0 waiting" to it made
      // "nothing is running" impossible to say, which is the answer a person most wants.
      if (!rows.length && !waiting && !state.torn && !stuckRows.length) {
        return { code: 0, lines: ['nothing is running'] };
      }
      if (state.torn) {
        rows.push(`journal: ${state.torn} torn line(s), which is a crash somebody should read`);
      }
      rows.push(`inbox: ${waiting} waiting`);
      return { code: 0, lines: [...stuckRows, ...rows] };
    }

    case 'up': {
      const state = replay(journalPath());

      // Before anything else starts: pick up whatever the registry says crashed. A row
      // with a live pid is left alone (some other process still owns it); a row with a
      // dead pid and a session id gets exactly one resume attempt; a row with no session
      // id at all cannot be resumed and is only reported.
      const registry = new Registry(registryDir());
      const reconcileEngine = deps.engine ?? new SdkEngine({
        journalPath: journalPath(), inboxDir: inboxDir(), gotchasDir: gotchasDir(),
      });
      const reconcileJournal = new Journal(journalPath());
      let reconciled: Awaited<ReturnType<typeof reconcileRegistry>>;
      try {
        reconciled = await reconcileRegistry(registry, reconcileEngine, reconcileJournal, deps.alive);
      } finally {
        reconcileJournal.close();
        await reconcileEngine.close?.();
      }
      const reconcileLines = reconciled.map((outcome) => (outcome.ok
        ? `reconciled ${outcome.goal}: resumed by session id`
        : `could not reconcile ${outcome.goal}: ${outcome.reason}`));

      // P4.7/I4: the `claude` provider behind every `Reasoner` seam this process wires
      // up below -- the router here and the Warden tick's conformance drift further
      // down. `deps.reasonerQueryFn` is the only override, for specimens; every real
      // run gets the SDK's own `query` (`Engine`'s default).
      const reasonerJournal = new Journal(journalPath());
      const reasoner = reasonerFor('claude', {
        journal: reasonerJournal, queryFn: deps.reasonerQueryFn,
      });

      const sharedJournalCache = new JournalCache();
      const server = new ForgeServer({
        lanes, inbox, journalPath: journalPath(), journalCache: sharedJournalCache, registry,
        stuck: () => liveness.stuck(),
        reasoner,
        fleet: () => {
          const read = fleetSnapshot(deps);
          return Array.isArray(read) ? read.map((proc) => ({ ...proc })) : read;
        },
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
      const wardenTick = new WardenTick({
        journal: wardenJournal,
        actuator: wardenActuator,
        blockers: wardenBlockers,
        reasoner,
        now: () => Date.now(),
        stuck: () => liveness.stuck(),
        isRegisteredRun: (key: string) => Boolean(registry.get(key)) || Boolean(lanes.get(key)),
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
                .slice(-5)
                .map((event) => String(event['tool'] ?? ''));
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
      return {
        code: 0,
        lines: [
          `forge ${runtimeVersion()} up on http://127.0.0.1:${port}`,
          `replayed ${state.events.length} events, ${Object.keys(state.runs).length} run(s)`,
          state.torn ? `${state.torn} torn journal line(s) survived and were skipped` : '',
          ...reconcileLines,
          `inbox: ${inbox.open().length} waiting`,
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
      const { dryRun, maxContext, maxTurns, condition, invalid, autoAnswer } = parseRunArgs(rest.slice(1));
      if (invalid) {
        // Refused before checkLaunch and before any lane is written: a NaN ceiling never
        // fires, which is the exact silent-unbounded-run this check exists to close.
        return { code: 2, lines: [`refusing to start: ${invalid}`] };
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
      const slug = briefPath.split(/[\\/]/).pop()!.replace(/\.md$/, '');
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

      // P4.7/I3: checkBudget at admission. What this run "would spend" is unknowable
      // before it opens a session, so this is a daily-cap gate in practice: today's
      // burn (summed off every result.usage row already on the journal) plus zero more
      // against the fleet's daily ceiling. A class whose own per-run cap is 0 would also
      // be caught; enforcing the per-run cap for real needs a cost estimate this
      // integration does not build, named here rather than pretended.
      const launchClass = tierOfBrief(brief);
      const spentTodayUsd = Object.values(
        buildBurnLedger(replay(journalPath()).events).byRun,
      ).reduce((sum, usd) => sum + usd, 0);
      const budgetDecision = checkBudget(slug, launchClass, 0, spentTodayUsd);
      if (!budgetDecision.allowed) {
        return {
          code: 1,
          lines: [`refusing to start ${slug}: budget cap (${String(budgetDecision.event?.['reason'])})`],
        };
      }

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
        return { code: 0, lines: ['kill switch cleared; forge run may start again'] };
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
      if (rest.includes('--once')) {
        // P4.7/I5: `forge intake --once`, exported so the console's router (cut 2) calls
        // the same function rather than a second copy of this wiring. Production passes
        // no feeds -- no real per-source client exists yet, decision 1's Jira token
        // included -- so a real run polls zero sources and says so, honestly, rather
        // than fabricating a client this codebase has not built.
        const feeds = deps.intakeFeeds ?? [];
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

    case 'council': {
      const repoFlag = rest.indexOf('--repo');
      const prFlag = rest.indexOf('--pr');
      const repo = repoFlag >= 0 ? rest[repoFlag + 1] : undefined;
      const prRaw = prFlag >= 0 ? rest[prFlag + 1] : undefined;
      const pr = prRaw ? Number.parseInt(prRaw, 10) : NaN;
      if (!repo || !Number.isFinite(pr)) {
        return { code: 2, lines: ['forge council --repo OWNER/NAME --pr N [--base BRANCH]'] };
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
        return {
          code: 2,
          lines: [`refused: checks are ${snapshot.checks.conclusion} on head `
            + `${snapshot.headSha}, not green`],
        };
      }

      const councilJournal = new Journal(journalPath());
      try {
        const reasoner = reasonerFor('claude', { journal: councilJournal, queryFn: deps.reasonerQueryFn });
        const ruleVerdict = evaluateAction({
          kind: 'pr', op: 'merge', repo, title: snapshot.title, body: snapshot.body, cwd: process.cwd(),
        });
        // Item 7, 2026-09-05: the PR this round is reasoning about, so a reasoner spend
        // for either role attributes back to it rather than showing up as unattributed
        // cost on the fleet's burn ledger.
        const councilRun = `${repo}#${pr}`;
        const roles = {
          lensRunner: reasonerLensRunner(reasoner, [ruleVerdict], councilRun),
          codexLane: codexLaneFor(policy),
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
          };
        }

        const attestation: CouncilAttestation = {
          repo, pr, head: snapshot.headSha, base: snapshot.baseSha, round: 1,
          verdict: round.verdict, decidingFindings: round.decidingFindings, lenses: round.lensReports,
          ...(round.codexRan ? { codex: { ran: true, findings: round.codexOnly } } : {}),
          judge: { model: modelIdFor(modelFor('audit-judge')), verdict: round.verdict },
          ci: { runId: snapshot.checks.runId, headSha: snapshot.checks.headSha },
          at: verified(Date.now(), 'gh pr view'),
        };
        const attPath = writeAttestation(attestation);
        councilJournal.append({
          event: 'council.attested', actor: 'council', repo, pr, head: snapshot.headSha,
          verdict: round.verdict, path: attPath,
        });

        return {
          code: 0,
          lines: [
            `verdict: ${round.verdict}`,
            ...(findingLines.length ? findingLines : ['no deciding findings']),
            `attestation: ${attPath}`,
          ],
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
        };
      }

      let haiping: HaipingHandoff | undefined;
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

      if (!merge) {
        return {
          code: 0,
          lines: [`gate: PASS -- ${repo}#${pr} at ${snapshot.headSha} clears (${attestation.verdict})`],
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
        };
      }

      const gateJournal = new Journal(journalPath());
      try {
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
        await gh.mergePr(repo, pr, call.subject, call.body);

        const view = await gh.viewPrState(repo, pr);
        write = reconcileMerge(write, view);
        gateJournal.append({
          event: write.state === 'complete' ? 'external.complete' : 'external.unknown',
          actor: 'council', kind: write.kind, idempotencyKey: write.idempotencyKey, state: write.state,
        });

        return {
          code: write.state === 'complete' ? 0 : 1,
          lines: [`merge ${write.state}: ${repo}#${pr}`],
        };
      } finally {
        gateJournal.close();
      }
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
            + '| council --repo O/N --pr N | gate --repo O/N --pr N [--merge] [--handoff FILE]',
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
