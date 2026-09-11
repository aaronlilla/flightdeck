/**
 * Getting a console onto 127.0.0.1:4120: probe, attach if something is
 * already there, otherwise spawn it and wait for it to answer.
 *
 * All I/O is injected (the port probe, the process spawn, the wait clock),
 * so the ordering and the attach/start decision are things a test can drive
 * without a real server or a real child process.
 */
import { randomUUID } from 'node:crypto';
import {
  decideConsoleAction, planStart,
  type StartCommandFs, type BuildStep, type ConsoleHealth,
} from './server-mode';

export interface ProbeResult {
  reachable: boolean;
}

export interface HealthProbeResult {
  health: ConsoleHealth;
}

export interface QueueLockOwner {
  pid: number;
  alive: boolean;
}

export interface Spawned {
  pid?: number;
  onExit(handler: (code: number | null) => void): void;
  onOutput(handler: (chunk: string) => void): void;
  kill(): void;
}

export interface BuildOutcome {
  ok: boolean;
  /** Combined stdout/stderr, for the failure message and the log tail. */
  output: string;
}

export interface SupervisorDeps {
  probe(): Promise<ProbeResult>;
  /** Item 3, 2026-09-10 (critique finding, was unwired): the health-aware probe
   *  that actually decides attach/start/wait/show-no-console/confirm-restart via
   *  `decideConsoleAction` -- kept separate from `probe()` above, which stays the
   *  simple boolean the post-spawn wait loop polls with. */
  probeHealth(): Promise<HealthProbeResult>;
  /** Reads `<home>/.forge/console/queue.lock`'s owner and whether it is alive.
   *  `undefined` when there is no lock file. */
  queueLockOwner(): QueueLockOwner | undefined;
  spawn(command: string, args: string[], cwd: string, env: Record<string, string>): Spawned;
  fs: StartCommandFs;
  join(...parts: string[]): string;
  nodeExecPath: string;
  /** The user's home directory: where `.forge/console.launch.cmd` and `.forge/console.env.cmd` live. */
  homeDir: string;
  /** Polls `probe()` on an interval until it is reachable or `timeoutMs`
   *  elapses. Injected so a test can drive it without real timers. */
  waitUntilReachable(probe: () => Promise<ProbeResult>, timeoutMs: number): Promise<boolean>;
  onLog(line: string): void;
  /** Item 4, 2026-09-10: runs the fallback plan's `buildStep` to completion before
   *  `spawn` -- injected so a test never shells a real vite build. Never called for
   *  a `launcher` plan (the launcher script owns its own pre-check, `launcher-plan.ts`). */
  runBuild(step: BuildStep): Promise<BuildOutcome>;
}

export type SupervisorOutcome =
  | { mode: 'attach' }
  | { mode: 'start'; process: Spawned }
  | { mode: 'start-failed'; reason: string }
  /** decideConsoleAction === 'wait': an alive queue-lock owner is starting or
   *  running the console already; never launch a second one into it. */
  | { mode: 'wait'; ownerPid: number }
  /** decideConsoleAction === 'show-no-console': the server answers but has no
   *  page built -- never silently attach to it as if it were ready. */
  | { mode: 'show-no-console' }
  /** decideConsoleAction === 'confirm-restart': something not forge-shaped holds
   *  the port. Proposal only -- this outcome never itself calls
   *  `proposeConfirmRestart`/`confirmRestart`; the caller decides whether and how
   *  to surface the confirm-gated restart. */
  | { mode: 'confirm-restart' };

/** Ten minutes: long enough for a cold `npm run forge -- up` with no build
 *  cache, short enough that a genuinely stuck launch is reported rather than
 *  waited on forever. */
export const START_TIMEOUT_MS = 10 * 60 * 1000;

export async function bringUpConsole(checkoutDir: string, deps: SupervisorDeps): Promise<SupervisorOutcome> {
  const health = (await deps.probeHealth()).health;
  const lockOwner = deps.queueLockOwner();
  const action = decideConsoleAction(health, lockOwner?.alive ?? false);

  if (action === 'wait') {
    deps.onLog(`a console (pid ${lockOwner!.pid}) is starting or running; waiting for it to become healthy`);
    return { mode: 'wait', ownerPid: lockOwner!.pid };
  }
  if (action === 'show-no-console') {
    deps.onLog('the console answered but has no page built yet; not attaching until it does');
    return { mode: 'show-no-console' };
  }
  if (action === 'confirm-restart') {
    deps.onLog('something on 127.0.0.1:4120 does not look like a forge console; a restart needs confirmation');
    return { mode: 'confirm-restart' };
  }
  if (action === 'attach') {
    deps.onLog('a console is already running on 127.0.0.1:4120; attaching to it');
    return { mode: 'attach' };
  }

  const plan = planStart(deps.fs, deps.join, checkoutDir, deps.nodeExecPath, deps.homeDir);
  if (plan.kind === 'launcher') {
    deps.onLog(`starting the console through ${plan.scriptPath}`);
  } else {
    const envNote = plan.envFileVarsCount > 0 ? ` with ${plan.envFileVarsCount} settings from console.env.cmd` : '';
    deps.onLog(`no launcher script; building the console before starting${envNote}`);
    const build = await deps.runBuild(plan.buildStep);
    if (!build.ok) {
      deps.onLog(build.output);
      return { mode: 'start-failed', reason: `the console build failed: ${build.output.slice(-500)}` };
    }
    deps.onLog('build finished; starting forge up from the checkout');
  }

  const child = deps.spawn(plan.command, plan.args, plan.cwd, plan.env);
  child.onOutput((chunk) => deps.onLog(chunk));

  const ready = await deps.waitUntilReachable(() => deps.probe(), START_TIMEOUT_MS);
  if (!ready) {
    child.kill();
    return { mode: 'start-failed', reason: `the console did not answer on 127.0.0.1:4120 within ${START_TIMEOUT_MS / 1000}s` };
  }

  if (plan.kind === 'launcher') {
    // The launcher's console belongs to its own loop script, started detached
    // through WMI, not to this app. Reporting it as `attach` keeps the
    // existing quit rule (an attached server is never stopped) applying here
    // too, so closing this app never takes the console down with it.
    deps.onLog('the console is running under its own launcher, not this app; it will keep running after this app quits');
    return { mode: 'attach' };
  }
  return { mode: 'start', process: child };
}

/**
 * "Restart through the launcher" (plan step 6, item 2, 2026-09-10): the one kill
 * this goal adds, and it is confirm-gated, pid-only, and refused outright when
 * any live registry run descends from the console's own pid -- killing the
 * console would take a live worker down with it, which the never-kill-workers
 * rule forbids absolutely.
 *
 * Two-phase, mirroring the shape of the server's own `confirmGate`
 * (`src/forge/console/command.ts:613`) without importing it -- main-process
 * code does not reach into server modules. `proposeConfirmRestart` spawns and
 * kills nothing; it only checks the refusal and, if clear, mints a token.
 * `confirmRestart` re-checks the same refusal (time may have passed) and only
 * then kills -- pid-only, never `/T`.
 */
export interface ConfirmRestartDeps {
  /** Every live registry run's pid that is a descendant of `consolePid`
   *  (children, grandchildren, ...). Empty means nothing depends on it. */
  liveDescendantPids(consolePid: number): Promise<number[]>;
  /** Kills exactly `pid`, and nothing else -- never a process-tree kill. */
  killPidOnly(pid: number): Promise<void>;
}

export type ProposeConfirmRestartResult =
  | { kind: 'proposed'; token: string; blast: string }
  | { kind: 'refused'; reason: string };

export type ConfirmRestartResult =
  | { ok: true }
  | { ok: false; reason: string };

const pendingRestarts = new Map<string, number>();

function refusalReason(consolePid: number, livePids: number[]): string {
  return `refusing to restart: ${livePids.length} live run(s) descend from console pid `
    + `${consolePid} (${livePids.join(', ')}) and would be killed with it`;
}

export async function proposeConfirmRestart(
  consolePid: number,
  deps: Pick<ConfirmRestartDeps, 'liveDescendantPids'>,
): Promise<ProposeConfirmRestartResult> {
  const live = await deps.liveDescendantPids(consolePid);
  if (live.length > 0) {
    return { kind: 'refused', reason: refusalReason(consolePid, live) };
  }
  const token = randomUUID();
  pendingRestarts.set(token, consolePid);
  return {
    kind: 'proposed',
    token,
    blast: `this will kill the console (pid ${consolePid}) and start a fresh one through the launcher`,
  };
}

export async function confirmRestart(token: string, deps: ConfirmRestartDeps): Promise<ConfirmRestartResult> {
  const consolePid = pendingRestarts.get(token);
  if (consolePid === undefined) {
    return { ok: false, reason: 'no pending restart for that token (already used, or never proposed)' };
  }
  pendingRestarts.delete(token);
  const live = await deps.liveDescendantPids(consolePid);
  if (live.length > 0) {
    return { ok: false, reason: refusalReason(consolePid, live) };
  }
  await deps.killPidOnly(consolePid);
  return { ok: true };
}
