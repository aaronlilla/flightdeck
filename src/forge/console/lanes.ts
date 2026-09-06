/**
 * `GET /lanes`: the board's own `Lane[]`, computed from what the runner already folds --
 * the registry, the journal, the chain and the inbox -- rather than a shape a worker
 * writes for the console directly. A field with no real source yet reads as the
 * contract's own null/0 rather than a guess wearing a number's shape.
 */
import type { ForgeEvent, FleetState, RunState } from '../journal.js';
import type { LaneRecord } from '../supervisor.js';
import type { RegistryRecord } from '../registry.js';
import type { InboxEntry } from '../inbox.js';
import type { StuckSignal } from '../liveness.js';
import type { ChainPacketState } from '../chain.js';
import type { ClassSpec } from '../policy.js';
import type { Hop, Lane, LanePr, LaneQuestion, LaneSandbox, LaneState, LanesResponse } from '../../shared/console-model.js';
import { textFor } from './journal-route.js';

/** `ChainHop`'s own order, index 0..3 of the console's six-hop pipeline (poll, provision,
 *  launch, gate, merge, jira) -- `unrouted` fills the `poll` slot, since nothing in the
 *  chain names a hop before it. */
const CHAIN_HOP_ORDER: readonly string[] = ['unrouted', 'provision', 'launch', 'gate'];

const TICKET_PATTERN = /^[a-z]+-\d+$/i;

/** `RunState.ticket`, or the run's own name when it reads as a ticket key
 *  (`^[a-z]+-\d+$`), upper-cased. `null` when neither is true. */
export function ticketFor(run: string, runState: RunState | undefined): string | null {
  if (runState?.ticket) return runState.ticket.toUpperCase();
  if (TICKET_PATTERN.test(run)) return run.toUpperCase();
  return null;
}

/** `claude-sonnet-5[...]` -> `sonnet-5`, `claude-opus-5` -> `opus-5`,
 *  `claude-haiku-4-5-*` -> `haiku-4.5`. Anything else passes through unchanged, since
 *  guessing a shorter alias for a model this policy never named would be a display value
 *  wearing more confidence than the data backs. */
export function modelAlias(modelId: string | null | undefined): string {
  if (!modelId) return 'unknown';
  const base = modelId.split('[')[0] ?? modelId;
  if (base.startsWith('claude-sonnet-5')) return 'sonnet-5';
  if (base.startsWith('claude-opus-5')) return 'opus-5';
  if (base.startsWith('claude-haiku-4-5')) return 'haiku-4.5';
  return base;
}

function packetForRun(chain: Map<string, ChainPacketState>, run: string): ChainPacketState | undefined {
  for (const row of chain.values()) {
    if (row.launched?.runKey === run || row.packetId === run) return row;
  }
  return undefined;
}

/** Whether an `external.complete` row for a `jira-*` write names this run's own ticket,
 *  anywhere in the journal (the Jira handoff runs once, well after the run itself has
 *  finished, so it is never scoped to the run's own events). */
function jiraWritesComplete(events: ForgeEvent[], ticket: string | null): boolean {
  if (!ticket) return false;
  return events.some((row) => (
    row.event === 'external.complete'
    && typeof row.kind === 'string' && row.kind.startsWith('jira-')
    && row.ticket === ticket
  ));
}

export interface HopInfo {
  hop: Hop;
  hopStatus: 'live' | 'done' | 'blocked';
}

/** unrouted -> 0, provision -> 1, launch -> 2, gate -> 3, merged -> 4 (done), jira writes
 *  complete -> 5 (done). A run with no chain packet at all defaults to hop 2 (launch)
 *  while it is running, or hop 0 otherwise -- there is nothing chain-shaped to read for
 *  a run the chain never planned. */
export function hopFor(packet: ChainPacketState | undefined, running: boolean, jiraDone: boolean): HopInfo {
  if (!packet) return running ? { hop: 2, hopStatus: 'live' } : { hop: 0, hopStatus: 'live' };
  if (packet.blocked) {
    const index = CHAIN_HOP_ORDER.indexOf(packet.blocked.hop);
    return { hop: (index >= 0 ? index : 0) as Hop, hopStatus: 'blocked' };
  }
  if (packet.merged) return jiraDone ? { hop: 5, hopStatus: 'done' } : { hop: 4, hopStatus: 'done' };
  if (packet.stopped) return { hop: 4, hopStatus: 'blocked' };
  if (packet.gated || packet.launched) return { hop: 3, hopStatus: 'live' };
  if (packet.provisioned) return { hop: 2, hopStatus: 'live' };
  return { hop: 1, hopStatus: 'live' };
}

const STATE_ENTRY_EVENTS: Record<LaneState, string[]> = {
  running: ['run.started', 'run.resumed'],
  'handed-off': ['run.handoff'],
  paused: ['run.paused'],
  parked: ['run.parked', 'warden.parked', 'governor.parked'],
  done: ['run.finished'],
  exhausted: ['run.finished'],
  unverified: ['run.finished'],
  merged: ['chain.merged'],
  blocked: ['run.blocked', 'chain.blocked'],
  killed: ['run.killed'],
};

/** The `at` of the most recent event that plausibly caused `state`, walking the run's own
 *  events (already filtered and in ascending order) backwards. Falls back to the run's
 *  `lastEventAt` when nothing matches -- a state read from the lane record rather than
 *  the journal (no run ever emitted an event for it) still gets an honest `since`. */
export function sinceFor(state: LaneState, runEvents: ForgeEvent[], fallback: number): number {
  const names = STATE_ENTRY_EVENTS[state];
  for (let index = runEvents.length - 1; index >= 0; index -= 1) {
    const row = runEvents[index]!;
    if (names.includes(row.event)) return row.at;
  }
  return fallback;
}

export interface LaneStateResult {
  state: LaneState;
  reason: string | null;
}

/**
 * The lane's own `LaneState`, and why -- in the precedence order the brief lays out:
 * a merged chain packet wins outright, then an explicit `needs_aaron` flag, then the
 * run's own last event being `run.blocked` or `run.killed` (nothing later has moved it
 * on), then a chain-level block, then the registered run state, then the lane record's
 * own last-known verdict for a run the journal never heard from at all.
 */
export function laneStateFor(input: {
  packet: ChainPacketState | undefined;
  lane: LaneRecord;
  runState: RunState | undefined;
  runEvents: ForgeEvent[];
}): LaneStateResult {
  const { packet, lane, runState, runEvents } = input;

  if (packet?.merged) return { state: 'merged', reason: null };

  if (lane.needs_aaron) return { state: 'blocked', reason: lane.needs_aaron };

  const lastOwnEvent = runEvents[runEvents.length - 1];
  if (lastOwnEvent?.event === 'run.killed') {
    return { state: 'killed', reason: typeof lastOwnEvent.reason === 'string' ? lastOwnEvent.reason : null };
  }
  if (lastOwnEvent?.event === 'run.blocked') {
    return { state: 'blocked', reason: typeof lastOwnEvent.reason === 'string' ? lastOwnEvent.reason : null };
  }

  if (packet?.blocked) return { state: 'blocked', reason: packet.blocked.reason };
  if (packet?.stopped) return { state: 'blocked', reason: packet.stopped.reason };

  switch (runState?.state) {
    case 'started': return { state: 'running', reason: null };
    case 'paused': return { state: 'paused', reason: null };
    case 'parked': return { state: 'parked', reason: null };
    case 'handed-off': return { state: 'handed-off', reason: null };
    case 'finished': {
      const verdict = runState.verdict;
      if (verdict === 'killed' || verdict === 'skipped') return { state: 'killed', reason: null };
      if (verdict === 'exhausted') return { state: 'exhausted', reason: null };
      if (verdict === 'done') return { state: 'done', reason: null };
      return { state: 'unverified', reason: null };
    }
    default:
      break;
  }

  // No journal state at all: fall back to the lane record's own last-known verdict, the
  // way the old dashboard's `stateOf` did, rather than declaring a run this idle "running".
  if (lane.verdict === 'killed' || lane.verdict === 'skipped') return { state: 'killed', reason: null };
  if (lane.verdict === 'exhausted') return { state: 'exhausted', reason: null };
  if (lane.verdict === 'done') return { state: 'done', reason: null };
  return { state: 'unverified', reason: null };
}

export interface LaneBuildInput {
  lane: LaneRecord;
  now: number;
  fleet: FleetState;
  chain: Map<string, ChainPacketState>;
  registryRow: RegistryRecord | undefined;
  openAsks: InboxEntry[];
  stuck: StuckSignal[];
  classFor: (name: string) => ClassSpec | undefined;
  usdPerRun: Record<string, number>;
  capOverride: number | undefined;
  prFor: (run: string) => LanePr | null;
  attempt: number;
  usdPerHourValue: number;
}

function questionFor(id: string, openAsks: InboxEntry[]): LaneQuestion | null {
  const entry = openAsks.find((ask) => ask.runs.includes(id));
  if (!entry) return null;
  return { key: entry.key, text: entry.question, opts: entry.options, askedAt: entry.at };
}

function sandboxFor(packet: ChainPacketState | undefined, registryRow: RegistryRecord | undefined, id: string): LaneSandbox | null {
  const path = packet?.provisioned?.worktreePath ?? null;
  const branch = packet?.provisioned?.branch ?? null;
  const pid = registryRow?.pid ?? null;
  const sessionId = registryRow?.sessionId ?? null;
  if (!path && !branch && !pid && !sessionId) return null;
  return { id, path, branch, pid, sessionId };
}

export function buildLane(input: LaneBuildInput): Lane {
  const { lane, now, fleet, chain, registryRow, openAsks, stuck, classFor, usdPerRun, capOverride, prFor } = input;
  const id = lane.slug;
  const runState = fleet.runs[id];
  const runEvents = fleet.events.filter((row) => row.run === id);
  const packet = packetForRun(chain, id);

  const { state, reason } = laneStateFor({ packet, lane, runState, runEvents });

  const ticket = ticketFor(id, runState);
  const className = runState?.className ?? lane.className ?? null;
  const spec = className ? classFor(className) : undefined;
  const modelId = runState?.model ?? lane.model ?? null;

  const ctxCeiling = spec?.maxContext ?? 0;
  const ctxCompactAt = Math.round(ctxCeiling * 0.9);
  const capUsd = capOverride ?? (className ? usdPerRun[className] ?? null : null);
  const costUsd = runState ? runState.costUsd : lane.cost_usd;
  const running = state === 'running' || state === 'handed-off';
  const burnUsdPerMin = running ? Number((input.usdPerHourValue / 60).toFixed(4)) : 0;

  const fails = runEvents.filter((row) => row.event === 'run.blocked' || row.event === 'engine.error').length;

  const mtime = lane.started ?? now;
  const lastEventAt = runState?.lastEventAt || mtime;
  const observedAt = Math.max(mtime, lastEventAt);
  const verifiedAt = runState?.lastEventAt ?? null;
  const heart = state === 'running' || state === 'handed-off';
  const since = sinceFor(state, runEvents, lastEventAt);

  const stuckHint = stuck.find((signal) => signal.key === id);
  const blockedByIntegration = state === 'blocked' && reason
    ? /\b(github|jira|aws|codex|model-provider)\b/i.exec(reason)?.[1]?.toLowerCase() ?? null
    : null;

  const currentToolName = runState?.currentTool?.name;
  const stepText = currentToolName ?? (runEvents.length ? textFor(runEvents[runEvents.length - 1]!) : '');

  const ticketForJira = ticket;
  const jiraDone = jiraWritesComplete(fleet.events, ticketForJira);
  const { hop, hopStatus } = hopFor(packet, state === 'running', jiraDone);

  return {
    id,
    ticket,
    model: modelAlias(modelId),
    modelId,
    className,
    repo: packet?.repo ?? null,
    attempt: input.attempt,
    state,
    reason,
    stepN: runState?.turns ?? 0,
    stepTotal: spec?.maxTurns ?? 0,
    stepText,
    ctxTokens: runState ? runState.context : lane.context,
    ctxCeiling,
    ctxCompactAt,
    costUsd,
    capUsd,
    burnUsdPerMin,
    fails,
    hop,
    hopStatus,
    observedAt,
    verifiedAt,
    heart,
    since,
    startedAt: lane.started ?? mtime,
    endedAt: lane.ended ?? null,
    question: questionFor(id, openAsks),
    pr: prFor(id),
    sandbox: sandboxFor(packet, registryRow, id),
    blockedBy: blockedByIntegration ?? (stuckHint?.signal === 'fleet-unknown' ? 'fleet' : null),
    runaway: capUsd !== null && costUsd > capUsd,
    needsAaron: lane.needs_aaron ?? null,
  };
}

export interface LanesInput {
  laneRecords: LaneRecord[];
  fleet: FleetState;
  chain: Map<string, ChainPacketState>;
  registryGet: (run: string) => RegistryRecord | undefined;
  openAsks: InboxEntry[];
  stuck: StuckSignal[];
  classFor: (name: string) => ClassSpec | undefined;
  usdPerRun: Record<string, number>;
  capOverrides: Record<string, number>;
  prFor: (run: string) => LanePr | null;
  usdPerHour: (lane: LaneRecord) => number;
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function computeLanes(input: LanesInput, now: number): LanesResponse {
  const attempts = new Map<string, number>();
  let burnUsdPerMin = 0;
  const lanes = input.laneRecords.map((lane) => {
    const attempt = (attempts.get(lane.column) ?? 0) + 1;
    attempts.set(lane.column, attempt);
    const usdPerHourValue = input.usdPerHour(lane);
    const built = buildLane({
      lane, now, fleet: input.fleet, chain: input.chain, registryRow: input.registryGet(lane.slug),
      openAsks: input.openAsks, stuck: input.stuck, classFor: input.classFor,
      usdPerRun: input.usdPerRun, capOverride: input.capOverrides[lane.slug], prFor: input.prFor,
      attempt, usdPerHourValue,
    });
    burnUsdPerMin += built.burnUsdPerMin;
    return built;
  });

  const since = startOfLocalDay(now);
  const spentTodayUsd = Object.entries(input.fleet.runs)
    .filter(([, run]) => run.lastEventAt >= since)
    .reduce((sum, [, run]) => sum + run.costUsd, 0);

  return { at: now, lanes, spentTodayUsd, burnUsdPerMin: Number(burnUsdPerMin.toFixed(4)) };
}
