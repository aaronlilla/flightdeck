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
import { asRunId, type Actuator } from '../contracts.js';
import { foldChainState, type ChainPacketState } from '../chain.js';
import { run as execRun, type RunRequest } from '../exec.js';
import { replay } from '../journal.js';
import { forgeHome } from '../paths.js';
import type { Registry } from '../registry.js';
import type { Lanes } from '../supervisor.js';
import { recordAction, type ActionsLedger } from './actions-ledger.js';
import { capsOverridesPath, readCapsOverrides, writeCapsOverrides } from './caps-read.js';
import { laneStateNowFor } from './lanes.js';
import type { ActionResult, LaneState } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';

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
  hardTokens: () => number;
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
  // `blocked` too: a warden trip (a tool call past its class budget, a stuck-session
  // signal) reads as blocked on the board, and once its cause is gone -- the budget
  // class was wrong, the process is back -- the only way onward was Kill. Seen live on
  // 2026-09-07 with a backend build parked for being slow. Resume relaunches from the
  // run's session; a run whose blocker still stands blocks again and says why.
  resume: ['paused', 'parked', 'blocked'],
  // `blocked` covers a liveness stuck-session signal, a stale cross-process park record,
  // and a chain-level block alike, and none of those give a blocked lane's own tile CTA
  // ("Gate log ->") anywhere to go besides reopening the same sheet. Confirmed live as a
  // genuine dead end: no Resume, no Kill, nothing. Kill has to reach a blocked run too --
  // whether or not its process is still alive, this is what closes the lane out.
  kill: ['running', 'handed-off', 'paused', 'parked', 'blocked'],
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
  const { jid, id } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'kill', run, text: `kill requested: ${reason}`, undo: null, extra: { reason },
  });
  // The actuator's `findDecision` matches a `decision.made` row by its own full id, the
  // same way the documented `forge decide RUN kill "<reason>"` CLI does -- never `jid`,
  // which is a shortened display form (`"J-"` + 8 hex chars) built for a receipt or a
  // `GET /journal` row. Passing `jid` here meant every board-driven kill recorded its
  // decision, then had the actuator refuse it a line later for failing to find that exact
  // decision -- reporting success to the operator while the process kept running.
  await deps.actuator.kill(asRunId(run), id);
  return { status: 200, body: { ok: true, jid, message: `kill requested for ${run}`, undoable: false } };
}

/**
 * "Pause" would suspend a live run's own turn loop mid-flight. Forge has no mechanism
 * for that today: `WardenActuator.park` (still driving a legitimate case elsewhere --
 * a conformance mismatch, or holding an already-parked ask open) only writes a
 * cross-process record `parkrecord.ts` owns, which the PreToolUse hook checks ahead of
 * the run's *next* tool call. `worker.ts`'s own turn loop never consults that record:
 * it only recognizes a park through the engine's in-process ask map, so a run denied by
 * this record just looks, from the worker's side, like an ordinary tool-call denial. It
 * nudges the model past the denial (up to `NUDGE_LIMIT` times), spending a real turn and
 * real cost on each attempt, and once the nudges run out the run gives up on its own.
 *
 * Driven live against a real run: clicking Pause put it into a roughly 90-second denial
 * spiral that kept billing the whole way, then the run finished on its own with the tile
 * stuck in `blocked` -- no Resume button and no Kill button anywhere on it, because that
 * lane state's own call-to-action never accounted for a run parked this way. Reporting
 * `ok: true` here would be the worst of the three controls this closed: a click that
 * reads as success while the run keeps running and spending. Honest refusal instead, the
 * same shape `compactRun` already answers with.
 */
export async function pauseRun(run: string, _reason: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!isRegistered(run, deps)) return notFound(run);
  const guard = guardState('pause', run, deps);
  if (guard) return guard;
  return {
    status: 501,
    body: {
      error: 'not wired',
      reason: `${run} can't be paused mid-turn: forge's park record only blocks the run's next tool `
        + "call, the worker doesn't read that as a park, so it nudges past the denial and keeps "
        + 'spending until it gives up on its own instead of actually suspending',
    },
  };
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

/** `~/.forge/console/caps.json` by default -- the same file, and the same
 *  `caps-read.ts`-owned shape, `GET`/`POST /caps` reads and writes. Per-run overrides
 *  live in its `perRun` field. */
export function capOverridesPath(override?: string): string {
  return override ?? capsOverridesPath(forgeHome());
}

export async function setRunCap(run: string, tokenCap: number, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!Number.isFinite(tokenCap) || tokenCap <= 0) {
    return { status: 400, body: { error: 'tokenCap must be a positive number' } };
  }
  const hardTokens = deps.hardTokens();
  if (tokenCap > hardTokens) {
    return {
      status: 422,
      body: { error: `${fmtTokens(tokenCap)} tokens is above the org hard limit of ${fmtTokens(hardTokens)} tokens`, reason: 'FD-7' },
    };
  }
  const path = capOverridesPath(deps.capsOverridesPath);
  const current = readCapsOverrides(path);
  const perRun = { ...(current.perRun ?? {}) };
  const previous = perRun[run] ?? null;
  perRun[run] = tokenCap;
  writeCapsOverrides(path, { ...current, perRun });
  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'run-cap', run, text: `cap set to ${fmtTokens(tokenCap)} tokens for ${run}`,
    undo: { kind: 'restore-run-cap', payload: { run, tokenCap: previous } },
  });
  return { status: 200, body: { ok: true, jid, message: `${run} capped at ${fmtTokens(tokenCap)} tokens`, undoable: true } };
}

/** Restores a per-run cap override to what it was before a `run-cap` write (or removes
 *  the override entirely when there was none). The one undo executor this module owns
 *  that `actions-ledger.ts`'s dispatcher (in `command.ts`) calls by `undo.kind`. */
export function restoreRunCap(run: string, tokenCap: number | null, deps: Pick<RunActionsDeps, 'capsOverridesPath'>): void {
  const path = capOverridesPath(deps.capsOverridesPath);
  const current = readCapsOverrides(path);
  const perRun = { ...(current.perRun ?? {}) };
  if (tokenCap === null) delete perRun[run];
  else perRun[run] = tokenCap;
  writeCapsOverrides(path, { ...current, perRun });
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
 * "Compact + resume" would hand a run off at its context ceiling and launch a successor
 * on the same model, the way `worker.ts`'s own ceiling branch does (`requestHandoff` ->
 * `run.handoff` -> a fresh `runName`, all inside that one running session's own turn
 * loop). This used to queue a copy of `HANDOFF_REQUEST` through the run's inbox and
 * answer `ok: true` -- a receipt that read like success for a click that did nothing:
 * `ceilingHit` in `sdkengine.ts` is set from the live context size alone, never from an
 * inbox message, so the model's reply to an injected copy of that text is never captured
 * as a packet, and no successor is ever started from it.
 *
 * There is no packet to hand a successor either way this action can reach: a `running`
 * lane's handoff packet, if one ever comes, is produced by the session's own next reply,
 * not synchronously inside this HTTP call; an `exhausted` lane never got one in the
 * first place (`worker.ts` marks a run exhausted precisely when it ran out of sessions
 * or turns without a ceiling hit to hand off from). Honest refusal, not a fake resume.
 */
export async function compactRun(run: string, deps: RunActionsDeps): Promise<RunActionResponse> {
  if (!isRegistered(run, deps)) return notFound(run);
  const guard = guardState('compact', run, deps);
  if (guard) return guard;
  return {
    status: 501,
    body: {
      error: 'not wired',
      reason: `${run} has no handoff packet to resume a successor from, only the running session's own `
        + 'reply to a context-ceiling handoff produces one, and the console cannot request that synchronously',
    },
  };
}
