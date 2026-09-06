/**
 * Per-run writes: kill, pause, resume, a per-run cap, and the gate actions (merge,
 * verify, reopen, compact).
 *
 * Every handler here finds the mechanism the rest of Forge already built and drives it
 * the same way a person at a terminal would, rather than inventing a console-only path:
 * kill writes the same `decision.made` row `forge decide RUN kill REASON` writes, then
 * hands its id to the same `WardenActuator` the Warden tick drives; pause and resume are
 * `WardenActuator.park`/`resume`, the same pair `warden-tick.ts` calls off a liveness
 * signal instead of an operator click; merge, verify and reopen spawn the same CLI
 * (`forge gate`, `forge chain retry`) a person would type. Where nothing in this
 * repository does the thing yet, the handler answers 501 rather than pretending.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { asRunId, type Actuator } from '../contracts.js';
import { foldChainState, type ChainPacketState } from '../chain.js';
import { run as execRun, type RunRequest } from '../exec.js';
import { replay } from '../journal.js';
import type { Registry } from '../registry.js';
import { RunInbox } from '../runinbox.js';
import { HANDOFF_REQUEST } from '../worker.js';
import type { Lanes } from '../supervisor.js';
import { consoleDir, recordAction, type ActionsLedger } from './actions-ledger.js';
import { laneStateNowFor } from './lanes.js';
import type { ActionResult, LaneState } from '../../shared/console-model.js';

export interface RunActionsDeps {
  ledger: ActionsLedger;
  registry: Registry;
  lanes?: Lanes;
  actuator: Actuator;
  journalPath: string;
  /** Overrides `child_process.spawn` for every CLI/`gh` call this module makes.
   *  Undefined in production; a specimen always sets it, per this stream's rule that
   *  a test never shells out. */
  spawnFn?: RunRequest['spawnFn'];
  hardUsd: () => number;
  capsOverridesPath?: string;
  /** Overrides the entry point spawned for `forge gate` / `forge chain retry`.
   *  Defaults to this process's own (`process.execPath`, `process.execArgv`,
   *  `process.argv[1]`), the same convention `chainLaunchArgv` uses so the spawned
   *  command works whether this server is running under `tsx` or compiled `dist/`. */
  cliArgv?: () => string[];
}

export type RunActionResponse = {
  status: number;
  body: ActionResult | { error: string; reason?: string } | { error: string; state: LaneState };
};

function isRegistered(run: string, deps: Pick<RunActionsDeps, 'registry' | 'lanes'>): boolean {
  return Boolean(deps.registry.get(run)) || Boolean(deps.lanes?.get(run));
}

function notFound(run: string): RunActionResponse {
  return { status: 404, body: { ok: false, jid: null, message: `${run} is not a registered run`, undoable: false } };
}

/** The lane states each action is allowed to run from. Answering ok on the wrong one is
 *  exactly how "pause a finished run" used to read as a success: nothing here checked
 *  the lane's own state before driving the actuator or the CLI. */
const ALLOWED_STATES: Record<'pause' | 'resume' | 'kill' | 'compact' | 'merge' | 'reopen', LaneState[]> = {
  pause: ['running', 'handed-off'],
  resume: ['paused', 'parked'],
  kill: ['running', 'handed-off', 'paused', 'parked'],
  compact: ['running', 'exhausted'],
  merge: ['done', 'unverified'],
  reopen: ['killed', 'blocked', 'exhausted'],
};

function wrongState(action: keyof typeof ALLOWED_STATES, state: LaneState): RunActionResponse {
  return {
    status: 409,
    body: { error: `${action} needs ${ALLOWED_STATES[action].join('/')}, not ${state}`, state },
  };
}

/** Checked before any of the six state-gated actions writes a journal row or drives a
 *  mechanism, so a refusal never leaves a `decision.made` row behind it. `undefined`
 *  when the action is allowed to proceed. */
function guardState(
  action: keyof typeof ALLOWED_STATES, run: string, deps: Pick<RunActionsDeps, 'journalPath' | 'lanes'>,
): RunActionResponse | undefined {
  const fleet = replay(deps.journalPath);
  const chain = foldChainState(fleet.events);
  const { state } = laneStateNowFor(run, { fleet, chain, laneRecord: deps.lanes?.get(run) });
  if (ALLOWED_STATES[action].includes(state)) return undefined;
  return wrongState(action, state);
}

function defaultCliArgv(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? 'forge'];
}

export async function killRun(run: string, reason: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!isRegistered(run, deps)) return notFound(run);
  const guard = guardState('kill', run, deps);
  if (guard) return guard;
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'kill', run, text: `kill requested: ${reason}`, undo: null, extra: { reason },
  });
  await deps.actuator.kill(asRunId(run), jid);
  return { status: 200, body: { ok: true, jid, message: `kill requested for ${run}`, undoable: false } };
}

export async function pauseRun(run: string, reason: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!isRegistered(run, deps)) return notFound(run);
  const guard = guardState('pause', run, deps);
  if (guard) return guard;
  const ok = await deps.actuator.park(asRunId(run), reason);
  if (!ok) {
    return {
      status: 409,
      body: { ok: false, jid: null, message: `refused: ${run} could not be parked`, undoable: false },
    };
  }
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'pause', run, text: `paused: ${reason}`, undo: { kind: 'resume-run', payload: { run } }, extra: { reason },
  });
  return { status: 200, body: { ok: true, jid, message: `paused ${run}`, undoable: true } };
}

export async function resumeRun(run: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!isRegistered(run, deps)) return notFound(run);
  const guard = guardState('resume', run, deps);
  if (guard) return guard;
  await deps.actuator.resume(asRunId(run), 'resume requested from the console');
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'resume', run, text: `resumed ${run}`, undo: null,
  });
  return { status: 200, body: { ok: true, jid, message: `resumed ${run}`, undoable: false } };
}

interface CapsOverrides {
  overrides: Record<string, number>;
}

function readCapsOverrides(path: string): CapsOverrides {
  if (!existsSync(path)) return { overrides: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CapsOverrides>;
    return { overrides: parsed.overrides ?? {} };
  } catch {
    return { overrides: {} };
  }
}

function writeCapsOverrides(path: string, value: CapsOverrides): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

export function capOverridesPath(override?: string): string {
  return override ?? join(consoleDir(), 'caps.json');
}

export async function setRunCap(run: string, capUsd: number, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return { status: 400, body: { error: 'capUsd must be a positive number' } };
  }
  const hardUsd = deps.hardUsd();
  if (capUsd > hardUsd) {
    return { status: 422, body: { error: `$${capUsd} is above the org hard limit of $${hardUsd}`, reason: 'FD-7' } };
  }
  const path = capOverridesPath(deps.capsOverridesPath);
  const current = readCapsOverrides(path);
  const previous = current.overrides[run] ?? null;
  current.overrides[run] = capUsd;
  writeCapsOverrides(path, current);
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'run-cap', run, text: `cap set to $${capUsd} for ${run}`,
    undo: { kind: 'restore-run-cap', payload: { run, capUsd: previous } },
  });
  return { status: 200, body: { ok: true, jid, message: `${run} capped at $${capUsd}`, undoable: true } };
}

/** Restores a per-run cap override to what it was before a `run-cap` write (or removes
 *  the override entirely when there was none). The one undo executor this module owns
 *  that `actions-ledger.ts`'s dispatcher (in `command.ts`) calls by `undo.kind`. */
export function restoreRunCap(run: string, capUsd: number | null, deps: Pick<RunActionsDeps, 'capsOverridesPath'>): void {
  const path = capOverridesPath(deps.capsOverridesPath);
  const current = readCapsOverrides(path);
  if (capUsd === null) delete current.overrides[run];
  else current.overrides[run] = capUsd;
  writeCapsOverrides(path, current);
}

function findChainRowForRun(run: string, journalPath: string): (ChainPacketState & { packetId: string }) | undefined {
  const state = replay(journalPath);
  const rows = foldChainState(state.events);
  for (const [packetId, row] of rows) {
    if (row.launched?.runKey === run) return { ...row, packetId };
  }
  return undefined;
}

interface GhPr {
  number: number;
}

/**
 * `merge` and `verify` share everything but the `--merge` flag: find the run's repo and
 * open PR from the chain's own rows (the same place `forge gate` would be told to look
 * by hand), then spawn `forge gate` exactly as a person would type it.
 */
async function gateAction(run: string, wantsMerge: boolean, deps: RunActionsDeps): Promise<RunActionResponse> {
  const row = findChainRowForRun(run, deps.journalPath);
  if (!row || !row.repo) {
    return { status: 501, body: { error: 'not wired', reason: `no chain packet names a repo for run ${run}` } };
  }
  const branch = row.provisioned?.branch;
  if (!branch) {
    return { status: 501, body: { error: 'not wired', reason: `no provisioned branch on record for run ${run}` } };
  }

  const listResult = await execRun({
    argv: ['gh', 'pr', 'list', '--repo', row.repo, '--head', branch, '--json', 'number'],
    cwd: process.cwd(),
    owner: `console-${run}-pr-list`,
    cls: 'script',
    fullOutput: true,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
  });
  let prs: GhPr[] = [];
  try {
    prs = JSON.parse(listResult.full ?? listResult.tail) as GhPr[];
  } catch {
    prs = [];
  }
  const pr = prs[0]?.number;
  if (!pr) {
    return { status: 501, body: { error: 'not wired', reason: `no open PR found for ${row.repo}@${branch}` } };
  }

  const argv = [
    ...(deps.cliArgv?.() ?? defaultCliArgv()),
    'gate', '--repo', row.repo, '--pr', String(pr),
    ...(wantsMerge ? ['--merge'] : []),
  ];
  const [command, ...args] = argv;
  const result = await execRun({
    argv: [command as string, ...args],
    cwd: process.cwd(),
    owner: `console-${run}-gate`,
    cls: 'script',
    fullOutput: true,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
  });
  const ok = result.returncode === 0;
  const summary = (result.full ?? result.tail).trim().split('\n').filter(Boolean).slice(-3).join(' | ')
    || (ok ? 'gate passed' : `gate exited ${result.returncode}`);
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: wantsMerge ? 'merge' : 'verify', run, text: summary, undo: null,
    extra: { exitCode: result.returncode, repo: row.repo, pr },
  });
  return { status: ok ? 200 : 502, body: { ok, jid, message: summary, undoable: false } };
}

export async function mergeRun(run: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  const guard = guardState('merge', run, deps);
  if (guard) return guard;
  return gateAction(run, true, deps);
}

export function verifyRun(run: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  return gateAction(run, false, deps);
}

export async function reopenRun(run: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  const guard = guardState('reopen', run, deps);
  if (guard) return guard;
  const row = findChainRowForRun(run, deps.journalPath);
  if (!row) {
    return { status: 501, body: { error: 'not wired', reason: `no chain packet found for run ${run}` } };
  }
  const argv = [...(deps.cliArgv?.() ?? defaultCliArgv()), 'chain', 'retry', row.packetId];
  const [command, ...args] = argv;
  const result = await execRun({
    argv: [command as string, ...args],
    cwd: process.cwd(),
    owner: `console-${run}-chain-retry`,
    cls: 'script',
    fullOutput: true,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
  });
  const ok = result.returncode === 0;
  const summary = (result.full ?? result.tail).trim() || (ok ? `unblocked ${row.packetId}` : `retry exited ${result.returncode}`);
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'reopen', run, text: summary, undo: null, extra: { exitCode: result.returncode, packetId: row.packetId },
  });
  return { status: ok ? 200 : 502, body: { ok, jid, message: summary, undoable: false } };
}

/**
 * Requests the same handoff a worker sends itself at the context ceiling
 * (`HANDOFF_REQUEST` in `worker.ts`), queued through the run's own inbox. Real, but
 * partial: nothing here launches the successor once the handoff lands -- that half of
 * "compact + resume" needs the chain to relaunch off the handoff packet, which this
 * write does not drive.
 */
export async function compactRun(run: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!isRegistered(run, deps)) return notFound(run);
  const guard = guardState('compact', run, deps);
  if (guard) return guard;
  new RunInbox(run).send(HANDOFF_REQUEST, 'console');
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'compact', run, text: `requested a handoff at the context ceiling for ${run}`, undo: null,
  });
  return {
    status: 200,
    body: {
      ok: true, jid, undoable: false,
      message: `handoff requested for ${run}; resuming a successor is not automated from the console yet`,
    },
  };
}
