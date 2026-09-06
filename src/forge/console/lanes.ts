/**
 * `GET /lanes`: the board's own `Lane[]`, computed from what the runner already folds --
 * the registry, the journal, the chain and the inbox -- rather than a shape a worker
 * writes for the console directly. A field with no real source yet reads as the
 * contract's own null/0 rather than a guess wearing a number's shape.
 */
import type { ForgeEvent, FleetState, RunState } from '../journal.js';
import { laneRecord, type LaneRecord } from '../supervisor.js';
import type { RegistryRecord } from '../registry.js';
import type { InboxEntry } from '../inbox.js';
import type { StuckSignal } from '../liveness.js';
import type { ChainPacketState } from '../chain.js';
import type { ClassSpec } from '../policy.js';
import type { Hop, Lane, LanePr, LaneQuestion, LaneSandbox, LaneState, LanesResponse } from '../../shared/console-model.js';
import { textFor } from './journal-route.js';

/** Journal rows that carry no narrative on their own: burn accounting, per-tool
 *  chatter, warden health pings. `stepText` and the "why is X stuck" reply both skip
 *  these unless nothing else is left to show, so a run's step text or its stuck
 *  explanation never reads as three `burn.mismatch` rows in a row. */
const NOISE_EVENTS = new Set(['burn.mismatch', 'result.usage', 'subagent.usage', 'warden.health', 'tool.end']);

/** `events`, minus noise rows, unless that leaves nothing. A run whose only rows are
 *  noise still needs something to render, not an empty step text. */
export function meaningfulEvents(events: ForgeEvent[]): ForgeEvent[] {
  const filtered = events.filter((row) => !NOISE_EVENTS.has(row.event));
  return filtered.length ? filtered : events;
}

/** `ChainHop`'s own order, index 0..3 of the console's six-hop pipeline (poll, provision,
 *  launch, gate, merge, jira) -- `unrouted` fills the `poll` slot, since nothing in the
 *  chain names a hop before it. */
const CHAIN_HOP_ORDER: readonly string[] = ['unrouted', 'provision', 'launch', 'gate'];

/** A ticket key as a whole `_`/`/`-delimited segment of a run name: 2 to 6 letters, no
 *  digits, then a literal `-`, then digits, and nothing else in that segment. The `-`
 *  inside the key is never a segment boundary itself (a ticket key always has one), so
 *  `forge-live-probe-10` reads as a single segment that fails this pattern rather than
 *  as `probe-10` -- there is nothing here to tell a real ticket-shaped run name apart
 *  from a hyphenated one that merely ends in a number. */
const TICKET_TOKEN_PATTERN = /^[A-Za-z]{2,6}-\d+$/;

/** `RunState.ticket`, or the first `_`/`/`-delimited segment of the run's own name that
 *  reads as a ticket key on its own, upper-cased. `null` when neither is true. */
export function ticketFor(run: string, runState: RunState | undefined): string | null {
  if (runState?.ticket) return runState.ticket.toUpperCase();
  const token = run.split(/[_/]/).find((part) => TICKET_TOKEN_PATTERN.test(part));
  return token ? token.toUpperCase() : null;
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

export interface ChainLink {
  key: string;
  runState: RunState | undefined;
}

/**
 * `id`'s handoff chain, in order, following `RunState.successor` from `id` itself to
 * the newest link the journal has folded a run state for.
 *
 * Stops the moment a successor is named but no run state has been folded for it yet --
 * a handoff still in flight, its successor not journaled as started -- since that named
 * run is not "newest" yet, the one that named it still is. Also stops on a repeated key,
 * so a chain that only ever grows is walked exactly once per render.
 */
export function chainLinks(runs: FleetState['runs'], id: string): ChainLink[] {
  const links: ChainLink[] = [];
  const seen = new Set<string>();
  let key = id;
  let runState = runs[key];
  links.push({ key, runState });
  while (runState?.successor && !seen.has(key)) {
    seen.add(key);
    const next = runs[runState.successor];
    if (!next) break;
    key = runState.successor;
    runState = next;
    links.push({ key, runState });
  }
  return links;
}

/** Whether any link in a handoff chain has a live registry row -- a process that could
 *  still spend. Backs both `heart` (I1) and `runaway` (I2): a chain whose last link
 *  finished, or whose handoff stalled with nothing left running, is neither. */
export function chainIsLive(
  links: ChainLink[], registryGet: (run: string) => RegistryRecord | undefined,
): boolean {
  return links.some((link) => Boolean(registryGet(link.key)));
}

export function packetForRun(chain: Map<string, ChainPacketState>, run: string): ChainPacketState | undefined {
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
 *  complete -> 5 (done). A run with no chain packet at all reads its hop off its own
 *  lane state instead, since there is nothing chain-shaped to read for a run the chain
 *  never planned: running/handed-off -> 2 (launch) live, done/unverified/exhausted -> 2
 *  done, blocked -> 3 blocked, and 0 only for a run that has not started anything yet
 *  (paused, parked, merged, killed). */
export function hopFor(packet: ChainPacketState | undefined, state: LaneState, jiraDone: boolean): HopInfo {
  if (!packet) {
    if (state === 'running' || state === 'handed-off') return { hop: 2, hopStatus: 'live' };
    if (state === 'done' || state === 'unverified' || state === 'exhausted') return { hop: 2, hopStatus: 'done' };
    if (state === 'blocked') return { hop: 3, hopStatus: 'blocked' };
    return { hop: 0, hopStatus: 'live' };
  }
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
  registryGet: (run: string) => RegistryRecord | undefined;
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
  // Same region/instanceType facts `sandbox.ts#computeSandbox` reports: no cloud sandbox
  // exists here, so `'local'` and this process's own platform/arch are the real answers.
  return { id, path, branch, pid, sessionId, region: 'local', instanceType: `${process.platform}/${process.arch}` };
}

export function buildLane(input: LaneBuildInput): Lane {
  const { lane, now, fleet, chain, registryRow, openAsks, stuck, classFor, usdPerRun, capOverride, prFor } = input;
  const id = lane.slug;
  // I1: a run that has handed off is read through the whole chain its successors form,
  // not just its own last journal line -- `fleet.runs[id]` never gets another event
  // once `id` hands off, so reading it alone leaves a finished chain stuck reading
  // `handed-off` forever. `terminal` is the newest link the journal has folded a run
  // state for; every field below that describes "what is this lane doing right now"
  // reads off it instead of off `id`'s own state.
  const links = chainLinks(fleet.runs, id);
  const terminal = links[links.length - 1]!;
  const runState = terminal.runState;
  const runEvents = fleet.events.filter((row) => row.run === terminal.key);
  const packet = packetForRun(chain, id);

  const { state, reason } = laneStateFor({ packet, lane, runState, runEvents });

  const ticket = ticketFor(id, runState);
  const className = runState?.className ?? lane.className ?? null;
  const spec = className ? classFor(className) : undefined;
  const modelId = runState?.model ?? lane.model ?? null;

  const ctxCeiling = spec?.maxContext ?? 0;
  const ctxCompactAt = Math.round(ctxCeiling * 0.9);
  const capUsd = capOverride ?? (className ? usdPerRun[className] ?? null : null);
  // I1: the chain's total spend, not just the newest link's -- every link in `links`
  // has a defined `runState` once `runState` (the terminal's) does, since the walk in
  // `chainLinks` only ever advances onto a link it already found a run state for.
  const costUsd = runState
    ? links.reduce((sum, link) => sum + (link.runState?.costUsd ?? 0), 0)
    : lane.cost_usd;
  const running = state === 'running' || state === 'handed-off';
  const burnUsdPerMin = running ? Number((input.usdPerHourValue / 60).toFixed(4)) : 0;

  const fails = runEvents.filter((row) => row.event === 'run.blocked' || row.event === 'engine.error').length;

  // I3: `lastEventAt` off the run's own last MEANINGFUL event, not `RunState.lastEventAt`
  // (every event bumps that, noise included) -- the governor's `burn.mismatch` re-fires
  // once per `forge up` restart for as long as a mismatch stays open (`reconcileBurnOnce`'s
  // dedup `Set` is per-process, not persisted), which otherwise reads a lane that finished
  // a day ago as observed seconds ago on every restart, defeating the 24h finished-lane
  // window in `windowLanes` below.
  const currentToolName = runState?.currentTool?.name;
  const meaningfulRunEvents = meaningfulEvents(runEvents);
  const lastMeaningfulEventAt = meaningfulRunEvents.length
    ? meaningfulRunEvents[meaningfulRunEvents.length - 1]!.at
    : undefined;
  const mtime = lane.started ?? now;
  const lastEventAt = lastMeaningfulEventAt ?? runState?.lastEventAt ?? mtime;
  const observedAt = Math.max(mtime, lastEventAt);
  const verifiedAt = runState?.lastEventAt ?? null;
  // I1/I2: a process that could still spend -- any link in the chain with a live
  // registry row, not just `id`'s own. Backs `heart` for a stalled handoff (running
  // needs none of this: the terminal's own state already says so) and `runaway` below.
  const chainLive = chainIsLive(links, input.registryGet);
  const heart = state === 'running' || (state === 'handed-off' && chainLive);
  const since = sinceFor(state, runEvents, lastEventAt);

  const stuckHint = stuck.find((signal) => signal.key === id);
  const blockedByIntegration = state === 'blocked' && reason
    ? /\b(github|jira|aws|codex|model-provider)\b/i.exec(reason)?.[1]?.toLowerCase() ?? null
    : null;

  const stepText = currentToolName
    ?? (meaningfulRunEvents.length ? textFor(meaningfulRunEvents[meaningfulRunEvents.length - 1]!) : '');

  const ticketForJira = ticket;
  const jiraDone = jiraWritesComplete(fleet.events, ticketForJira);
  const { hop, hopStatus } = hopFor(packet, state, jiraDone);

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
    // I2: a `handed-off` lane also needs a live registry row -- a process that could
    // still spend -- the same way `heart` does above; a genuinely `running` lane is
    // already live by definition (`laneStateFor` only reads that off the journal's own
    // `started` state) and needs no extra check. Combined with the chain fold above, a
    // finished chain over its cap never reads `running` or `handed-off` here at all, and
    // a stalled handoff over its cap with nothing left running shows its cost in amber
    // with the cap text instead of the red runaway treatment.
    runaway: running && capUsd !== null && costUsd > capUsd && (state === 'running' || chainLive),
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

/** The one spend-since-midnight figure every console read and write agrees on: `GET
 *  /lanes`, `GET /caps`, `POST /caps` and the `spend today` command all call this
 *  instead of each folding the journal their own way. */
export function spentTodayUsd(runs: FleetState['runs'], now: number): number {
  const since = startOfLocalDay(now);
  return Object.values(runs)
    .filter((run) => run.lastEventAt >= since)
    .reduce((sum, run) => sum + run.costUsd, 0);
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
      registryGet: input.registryGet,
      openAsks: input.openAsks, stuck: input.stuck, classFor: input.classFor,
      usdPerRun: input.usdPerRun, capOverride: input.capOverrides[lane.slug], prFor: input.prFor,
      attempt, usdPerHourValue,
    });
    burnUsdPerMin += built.burnUsdPerMin;
    return built;
  });

  return {
    at: now, lanes, spentTodayUsd: spentTodayUsd(input.fleet.runs, now),
    burnUsdPerMin: Number(burnUsdPerMin.toFixed(4)),
  };
}

const FINISHED_WINDOW_STATES = new Set<LaneState>(['done', 'merged', 'killed', 'exhausted', 'unverified']);
const FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `GET /lanes`'s default view: a finished lane (done, merged, killed, exhausted,
 *  unverified) drops off the board 24 hours after its own `observedAt`, so a board that
 *  has been running a while does not accumulate every run that ever finished. Running,
 *  handed-off, paused, parked and blocked lanes are never windowed out -- there is
 *  always a reason an operator would want to see one of those. `all` bypasses the
 *  window entirely, for the one screen (or `all=1` query) that wants the full history. */
export function windowLanes(response: LanesResponse, now: number, all: boolean): LanesResponse {
  if (all) return response;
  const cutoff = now - FINISHED_WINDOW_MS;
  const lanes = response.lanes.filter((lane) => (
    !FINISHED_WINDOW_STATES.has(lane.state) || lane.observedAt >= cutoff
  ));
  return { ...response, lanes };
}

/** The lane state (and why) for an arbitrary run right now, for a caller that only has
 *  a run name and a journal path -- a command-grammar handler answering "why is X
 *  stuck", or a write guarding what state an action is allowed from. Builds the same
 *  minimal stand-in `LaneRecord` `laneRecord()` would when no real lane file exists, so
 *  a run the lane store never wrote to still reads as `unverified` rather than throwing. */
export function laneStateNowFor(run: string, opts: {
  fleet: FleetState;
  chain: Map<string, ChainPacketState>;
  laneRecord?: LaneRecord;
}): LaneStateResult {
  const runEvents = opts.fleet.events.filter((row) => row.run === run);
  const packet = packetForRun(opts.chain, run);
  const runState = opts.fleet.runs[run];
  const lane = opts.laneRecord ?? laneRecord({ slug: run, column: run });
  return laneStateFor({ packet, lane, runState, runEvents });
}
