/**
 * The typed and runtime-checked shapes every Forge stream builds on.
 *
 * Roadmap P3.1. Six streams (Warden, Governor, Intake, Council, Console, Self-iteration)
 * are being built in parallel after this file, from a fresh session each, and none of
 * them may invent its own version of a shape another stream also needs. That is exactly
 * how `go.py`, `hooks/model_gate.py` and the Forge Phase 0 note disagreed on a model
 * policy until 2026-09-03 cost roughly $6,250 in four hours. So this file is the one
 * place a run's identity, its event envelope, its lifecycle, its tools and its `/state`
 * shape are declared, and every zod schema here is what actually runs at a process
 * boundary rather than a type nobody checks at runtime.
 *
 * Nothing here starts an SDK session, spawns a process, or writes outside a path it is
 * given. `FORGE_TOOLS` below inspects an in-memory MCP server object built with no-op
 * handlers; it never calls `query()`.
 *
 * Every export in this file is named in the goal brief's final Status, one line per
 * specification bullet naming the export that covers it (gate G4).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { buildForgeMcpServer, type ForgeToolHandlers } from '../adapter/engine.js';
import type { GotchaInput } from './gotcha.js';
import { CLASS_BUDGETS, DEFAULT_CLASS } from './exec.js';
import type { FleetProcess, LivenessSignal, StuckSignal } from './liveness.js';
import { LANE_FIELDS, type LaneRecord as BaseLaneRecord } from './supervisor.js';

export { LANE_FIELDS };

// ---------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------

/**
 * Branded identities.
 *
 * A `GoalId`, a `RunId` and a `SessionId` are all "just a string" at the value level, and
 * that is exactly the bug class this closes: a lane keyed by session id when a run id was
 * meant compiles cleanly and fails at 2am. `.brand()` costs nothing at runtime (the
 * schema still just checks `min(1)`) and stops the three kinds of string from being
 * interchangeable at compile time.
 */
export const GoalIdSchema = z.string().min(1).brand<'GoalId'>();
export type GoalId = z.infer<typeof GoalIdSchema>;

export const RunIdSchema = z.string().min(1).brand<'RunId'>();
export type RunId = z.infer<typeof RunIdSchema>;

export const SessionIdSchema = z.string().min(1).brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionIdSchema>;

export function asGoalId(value: string): GoalId {
  return GoalIdSchema.parse(value);
}

export function asRunId(value: string): RunId {
  return RunIdSchema.parse(value);
}

export function asSessionId(value: string): SessionId {
  return SessionIdSchema.parse(value);
}

/**
 * One process, identified so a dead pid reused by an unrelated process is never mistaken
 * for the run that used to hold it.
 *
 * `forge up`'s registry (B.3.5) stamps this at `system.init`, and reconciliation compares
 * a stored incarnation against the live one rather than the pid alone.
 */
export interface Incarnation {
  pid: number;
  /** The process's own start time, ms epoch, from the OS, not when the run was journaled. */
  startedAt: number;
}

export const IncarnationSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.number().int().positive(),
});

/**
 * `LANE_FIELDS` plus the fields the spec adds: `goal`, `className`, `provider`. Every
 * field `LANE_FIELDS` already names (`owner`, `session_id`, `claude_pid`, `model`,
 * `context`, `cost_usd`, ...) comes from `supervisor.ts`'s own `LaneRecord`, so a renamed
 * field there breaks this type rather than silently drifting from it.
 */
export interface LaneRecord extends BaseLaneRecord {
  goal: GoalId;
  className: string;
  provider: Provider;
}

export const LaneRecordSchema = z.object({
  slug: z.string().min(1),
  column: z.string(),
  owner: z.string().min(1),
  session_id: z.string().nullable(),
  claude_pid: z.number().int().nullable(),
  started: z.number().nullable(),
  ended: z.number().nullable(),
  verdict: z.string().nullable(),
  position: z.number().nullable(),
  note: z.string().nullable(),
  woken: z.number(),
  model: z.string().nullable(),
  context: z.number(),
  cost_usd: z.number(),
  handoff: z.string().nullable(),
  needs_aaron: z.string().nullable().optional(),
  zero_turn_starts: z.array(z.number()).optional(),
  goal: z.string().min(1),
  className: z.string().min(1),
  provider: z.enum(['codex', 'claude']),
}).passthrough();

// ---------------------------------------------------------------------------------------
// Events, and the replay contract
// ---------------------------------------------------------------------------------------

/**
 * Every event name in use on `main` today (`journal.ts`'s callers and `sdkengine.ts`'s
 * `forge.*` rows), plus the names B.3 and the spec add. Closed on purpose: a caller that
 * wants a new event name adds it here first, which is what makes the union worth having
 * over a bare `string`.
 */
export const FORGE_EVENT_NAMES = [
  // Today, on main.
  'ask.answered', 'ask.raised', 'cutover.completed', 'cutover.moved', 'engine.error',
  'forge.ask', 'forge.done', 'forge.handoff', 'forge.report', 'gotcha', 'inbox.delivered',
  'liveness.cleared', 'liveness.stuck', 'note', 'permission.denied', 'run.finished',
  'run.handoff', 'run.parked', 'run.paused', 'run.started', 'tool.end', 'tool.start',
  'turn.end',
  // The spec's additions (the "Contracts" paragraph of the 2026-09-04 13:45 refined
  // build-out plan).
  'run.resumed', 'inbox.queued', 'inbox.offered', 'inbox.acknowledged', 'stuck', 'cleared',
  'blocker.raised', 'blocker.cleared', 'external.intent', 'external.complete',
  'external.unknown', 'decision.made', 'source.observed', 'packet.written',
  // B.3's own new rows (B.3.9, B.3.10).
  'warden.parked', 'policy.unknown-model',
] as const;

export type ForgeEventName = (typeof FORGE_EVENT_NAMES)[number];

/**
 * The envelope every event carries, whatever role wrote it.
 *
 * `seq` is what lets a reader ask for "the tail since seq N" (the "snapshot plus tail"
 * replay mode `replayEvents` supports below) without re-parsing a multi-megabyte journal
 * on every `/state` poll or liveness tick, the exact `journal.ts`-re-parses-everything
 * cost B.3.9's leftovers bullet names. `version` is the schema version this envelope was
 * written under, so a future field rename can tell an old row from a new one instead of
 * guessing from which fields happen to be present.
 */
export interface ForgeEventEnvelope {
  id: string;
  seq: number;
  at: number;
  event: ForgeEventName;
  run?: RunId;
  goal?: GoalId;
  actor: string;
  cause?: string;
  ticket?: string;
  version: number;
  [key: string]: unknown;
}

export const ForgeEventSchema = z
  .object({
    id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    at: z.number().int().positive(),
    event: z.enum(FORGE_EVENT_NAMES),
    run: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
    actor: z.string().min(1),
    cause: z.string().min(1).optional(),
    ticket: z.string().min(1).optional(),
    version: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * What `replayEvents` promises, stated as data rather than left implicit in the folding
 * code: dedupe by id (a retried write of the same event is idempotent), a torn tail is
 * recovered (every complete line before it survives, the file is never truncated), an
 * interior corrupt row is quarantined (skipped and counted, never fatal), and a caller may
 * ask for a snapshot plus only the tail since a `seq` rather than the whole file.
 */
export interface ReplayContract {
  dedupeBy: 'id';
  tornTailRecovered: true;
  interiorCorruptionQuarantined: true;
  snapshotPlusTail: true;
}

export const REPLAY_CONTRACT: ReplayContract = {
  dedupeBy: 'id',
  tornTailRecovered: true,
  interiorCorruptionQuarantined: true,
  snapshotPlusTail: true,
};

export interface ReplayResult {
  events: ForgeEventEnvelope[];
  /** Ids seen more than once. Only the first copy of each is kept in `events`. */
  duplicates: string[];
  /** True when the last non-blank line did not parse: a process killed mid-write. */
  tornTail: boolean;
  /** Lines that did not parse and were NOT the last line: corruption, not a live crash. */
  quarantined: number;
}

/**
 * Fold a journal's lines into `ReplayResult`, honouring `REPLAY_CONTRACT`.
 *
 * Takes the file's text directly rather than a path, so a specimen can build a torn or
 * corrupt journal in memory without touching disk, and so this has no dependency on which
 * process wrote the file.
 *
 * `sinceSeq` implements the "snapshot plus tail" half of the contract: a caller who
 * already folded everything through `seq` N asks for `sinceSeq: N` and gets only the rows
 * after it, still deduped and still quarantining corruption in the slice it read.
 */
export function replayEvents(text: string, options: { sinceSeq?: number } = {}): ReplayResult {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  const seen = new Set<string>();
  const duplicates: string[] = [];
  const events: ForgeEventEnvelope[] = [];
  let tornTail = false;
  let quarantined = 0;

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) tornTail = true;
      else quarantined += 1;
      return;
    }
    const parsed = ForgeEventSchema.safeParse(row);
    if (!parsed.success) {
      if (index === lines.length - 1) tornTail = true;
      else quarantined += 1;
      return;
    }
    const event = parsed.data as ForgeEventEnvelope;
    if (seen.has(event.id)) {
      duplicates.push(event.id);
      return;
    }
    seen.add(event.id);
    if (options.sinceSeq !== undefined && event.seq <= options.sinceSeq) return;
    events.push(event);
  });

  return { events, duplicates, tornTail, quarantined };
}

// ---------------------------------------------------------------------------------------
// State: VerifiedField and the full /state type
// ---------------------------------------------------------------------------------------

/**
 * A value that is either merely observed (read from memory, or stamped with `Date.now()`
 * the way `server.ts:149-155` does today) or verified (re-derived from the thing that
 * actually backs it: a file's mtime, the journal's last event time). The two are a
 * discriminated union rather than one shape with an optional `verified_at` and an
 * independently optional `source`, because the bug this exists to close is exactly a
 * `verified_at` stamped with no source behind it: the 12:02 decision's truth auditor
 * needs `source` to be present whenever `verified_at` is, not merely encouraged to be.
 */
export type VerifiedField<T> =
  | { value: T; observed_at: number; verified_at?: undefined; source?: undefined }
  | { value: T; observed_at: number; verified_at: number; source: string };

export function observed<T>(value: T, observedAt: number = Date.now()): VerifiedField<T> {
  return { value, observed_at: observedAt };
}

export function verified<T>(value: T, source: string, verifiedAt: number = Date.now()): VerifiedField<T> {
  return { value, observed_at: verifiedAt, verified_at: verifiedAt, source };
}

/** A tool call a run has open, for `/state`'s per-run in-flight list. */
export interface InFlightTool {
  id: string;
  name: string;
  startedAt: number;
}

/** One run's slice of `/state`: the fields the 11:58 truth auditor decision asks for. */
export interface RunStateView {
  run: RunId;
  lastEventAgeS: number;
  inFlightTools: InFlightTool[];
  openStuck: StuckSignal[];
}

/**
 * The fleet process probe's report. `{ ok: false, reason }` is its own shape rather than
 * folded into the array, per `liveness.ts`'s own comment: a failed probe and a verified
 * empty fleet must never look the same, so a reader who forgets to check `ok` gets a type
 * error instead of reading a broken sensor as "nothing is stuck."
 */
export type FleetReport = FleetProcess[] | { ok: false; reason: string };

/** The full `/state` type: every top-level field carries its own `VerifiedField`. */
export interface ForgeStateSnapshot {
  at: number;
  lanes: VerifiedField<LaneRecord[]>;
  burn: VerifiedField<Record<string, number>>;
  handoffs: VerifiedField<number>;
  torn: VerifiedField<number>;
  inbox_open: VerifiedField<number>;
  stuck: VerifiedField<StuckSignal[]>;
  fleet: VerifiedField<FleetReport>;
  runs: Record<RunId, RunStateView>;
}

const VerifiedFieldSchema = <Value extends z.ZodTypeAny>(value: Value) =>
  z.union([
    z.object({ value, observed_at: z.number() }).strict(),
    z.object({ value, observed_at: z.number(), verified_at: z.number(), source: z.string().min(1) }).strict(),
  ]);

export const ForgeStateSnapshotSchema = z.object({
  at: z.number(),
  lanes: VerifiedFieldSchema(z.array(LaneRecordSchema)),
  burn: VerifiedFieldSchema(z.record(z.string(), z.number())),
  handoffs: VerifiedFieldSchema(z.number()),
  torn: VerifiedFieldSchema(z.number()),
  inbox_open: VerifiedFieldSchema(z.number()),
  stuck: VerifiedFieldSchema(z.array(z.record(z.string(), z.unknown()))),
  fleet: VerifiedFieldSchema(z.union([
    z.array(z.record(z.string(), z.unknown())),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ])),
  runs: z.record(z.string(), z.object({
    run: z.string().min(1),
    lastEventAgeS: z.number(),
    inFlightTools: z.array(z.object({ id: z.string(), name: z.string(), startedAt: z.number() })),
    openStuck: z.array(z.record(z.string(), z.unknown())),
  })),
});

// ---------------------------------------------------------------------------------------
// Tools: FORGE_TOOLS sourced from the adapter's own registration
// ---------------------------------------------------------------------------------------

const NOOP_FORGE_HANDLERS: ForgeToolHandlers = {
  onDone: () => {},
  onHandoff: () => {},
  onAsk: () => {},
  onGotcha: () => {},
  onReport: () => {},
};

/**
 * The tool names `buildForgeMcpServer` actually registers, read off the live server
 * object rather than copied into a second list.
 *
 * `WORKER_TOOLS` in `sdkengine.ts` IS a copied list, and it has already drifted: it names
 * four tools (no `forge_report`) against the five `buildForgeMcpServer` builds. That drift
 * is the falsifier a copied list can never catch and this reflection always does, because
 * it reads the same object the SDK is handed.
 *
 * `McpServer#_registeredTools` is a private field of `@modelcontextprotocol/sdk`, not a
 * public API; there is no other way to ask an `McpServer` instance what it registered
 * short of round-tripping a live `tools/list` request over a transport, which would mean
 * opening a connection just to read a list of strings. The type assertion below is the
 * one place that risk lives, named so a future SDK upgrade that renames the field fails
 * here (`registeredToolNames` throwing or returning `[]`) rather than silently.
 */
function registeredToolNames(): string[] {
  const server = buildForgeMcpServer(NOOP_FORGE_HANDLERS);
  const instance = server.instance as unknown as { _registeredTools?: Record<string, unknown> };
  const tools = instance._registeredTools;
  if (!tools || typeof tools !== 'object') {
    throw new Error(
      'buildForgeMcpServer\'s instance carries no _registeredTools object; the '
      + '@modelcontextprotocol/sdk internal shape FORGE_TOOLS reflects on has changed',
    );
  }
  return Object.keys(tools);
}

export const FORGE_TOOL_NAMES: string[] = registeredToolNames();

/** The SDK-visible names: `mcp__forge__forge_done` and siblings. */
export const FORGE_TOOLS: string[] = FORGE_TOOL_NAMES.map((name) => `mcp__forge__${name}`);

export const ForgeDoneInputSchema = z.object({ evidence: z.string().min(1) });
export const ForgeHandoffInputSchema = z.object({ packet: z.string().min(1) });
export const ForgeAskInputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
  kind: z.enum(['question', 'blocker']).optional(),
});
export const ForgeGotchaInputSchema = z.object({
  run: z.string().min(1),
  what: z.string().min(1),
  where: z.string().min(1),
  error: z.string().min(1),
  prevention: z.string().min(1),
  ticket: z.string().optional(),
});
export const ForgeReportInputSchema = z.object({
  outcome: z.string().min(1),
  done: z.string().min(1),
  leftOff: z.string().min(1),
  issues: z.string().optional(),
  blockers: z.string().optional(),
  unverified: z.string().optional(),
  cost: z.string().optional(),
});

/** Re-exported so a caller needs one import for every tool-input shape, this one included. */
export type { GotchaInput };

// ---------------------------------------------------------------------------------------
// RunReport (the 11:58 decision: every run ends with one of these)
// ---------------------------------------------------------------------------------------

export interface RunReportIssue {
  description: string;
  proposedFix: string;
}

export interface RunReportBlocker {
  key: string;
  blocks: string;
  commandAttempted: string;
  /** No verbatim error means this is an issue, not a blocker (the 11:58 decision's rule). */
  verbatimError: string;
  owner: string;
  tried: string;
  resumeAction: string;
}

export interface RunReportDecision {
  question: string;
  recommendedDefault: string;
}

export interface RunReport {
  run: RunId;
  outcome: { summary: string; causeId: string };
  done: { evidence: string };
  leftOff: { nextSteps: string[]; resumeState: string };
  issues: RunReportIssue[];
  blockers: RunReportBlocker[];
  unverified: string[];
  gotchasFiled: number;
  decisionsNeeded: RunReportDecision[];
  cost: { usd: number };
  /** Set when the worker died without filing one and the supervisor rebuilt it from the journal. */
  reconstructed?: boolean;
}

export const RunReportSchema = z.object({
  run: z.string().min(1),
  outcome: z.object({ summary: z.string().min(1), causeId: z.string().min(1) }),
  done: z.object({ evidence: z.string().min(1) }),
  leftOff: z.object({ nextSteps: z.array(z.string()), resumeState: z.string() }),
  issues: z.array(z.object({ description: z.string(), proposedFix: z.string() })),
  blockers: z.array(z.object({
    key: z.string().min(1),
    blocks: z.string(),
    commandAttempted: z.string(),
    verbatimError: z.string().min(1),
    owner: z.string().min(1),
    tried: z.string(),
    resumeAction: z.string(),
  })),
  unverified: z.array(z.string()),
  gotchasFiled: z.number().int().nonnegative(),
  decisionsNeeded: z.array(z.object({ question: z.string(), recommendedDefault: z.string() })),
  cost: z.object({ usd: z.number().nonnegative() }),
  reconstructed: z.boolean().optional(),
});

// ---------------------------------------------------------------------------------------
// Lifecycle: RunState and its legal transitions, as data
// ---------------------------------------------------------------------------------------

export const RUN_STATES = [
  'queued', 'admitted', 'running', 'handing-off', 'parked', 'paused', 'blocked',
  'verifying', 'done', 'failed', 'killed',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * Legal next states, as data rather than scattered `if` statements. The misuse gate (G3)
 * this closes: `done` is reachable only through `verifying`, never straight from `parked`.
 * A worker that calls `forge_done` while parked on an unanswered question must still
 * pass through `running` and `verifying` first.
 */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  queued: ['admitted', 'failed', 'killed'],
  admitted: ['running', 'failed', 'killed'],
  running: ['handing-off', 'parked', 'paused', 'blocked', 'verifying', 'failed', 'killed'],
  'handing-off': ['running', 'parked', 'failed', 'killed'],
  parked: ['running', 'killed'],
  paused: ['running', 'killed'],
  blocked: ['running', 'killed'],
  verifying: ['done', 'running', 'parked', 'failed'],
  done: [],
  failed: [],
  killed: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------------------
// Actuator, Ownership
// ---------------------------------------------------------------------------------------

/** The id of the decision that authorised a kill, carried so a kill is never anonymous. */
export type DecisionId = string;

/**
 * The only way anything is allowed to act on a run. `liveness.ts`'s own doctrine, "This
 * only watches," is what this interface exists to keep true: a watcher holds a
 * `StuckSignal`, never an `Actuator`.
 */
export interface Actuator {
  park(run: RunId, reason: string): Promise<void>;
  nudge(run: RunId, message: string): Promise<void>;
  resume(run: RunId, input: string): Promise<void>;
  /** `kill` alone carries a decision id: park, nudge and resume are reversible, this is not. */
  kill(run: RunId, decisionId: DecisionId): Promise<void>;
}

/**
 * What a run claims before it is admitted: a checkout, a lane, and every lock it needs,
 * plus a fencing token so a stale predecessor's write can be told apart from the current
 * owner's. `transferredTo` is set on a handoff, which is the one legal way ownership moves
 * without a fresh admission.
 */
export interface Ownership {
  goal: GoalId;
  run: RunId;
  checkout: string;
  lane: string;
  locks: string[];
  fencingToken: string;
  claimedAt: number;
  transferredTo?: RunId;
}

export const OwnershipSchema = z.object({
  goal: z.string().min(1),
  run: z.string().min(1),
  checkout: z.string().min(1),
  lane: z.string().min(1),
  locks: z.array(z.string()),
  fencingToken: z.string().min(1),
  claimedAt: z.number(),
  transferredTo: z.string().optional(),
});

// ---------------------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------------------

/**
 * The six roles Section 1 of the spec names as subscribers to the in-process bus: "Roles
 * are modules subscribed to it: `intake`, `governor`, `runner`, `warden`, `council`,
 * `console`." Roles publish facts and intents; none calls another directly.
 */
export const EVENT_BUS_ROLES = ['intake', 'governor', 'runner', 'warden', 'council', 'console'] as const;

export type EventBusRole = (typeof EVENT_BUS_ROLES)[number];

export interface EventBus {
  publish(role: EventBusRole, event: ForgeEventEnvelope): void;
  subscribe(role: EventBusRole, handler: (event: ForgeEventEnvelope) => void): () => void;
}

// ---------------------------------------------------------------------------------------
// Reasoner
// ---------------------------------------------------------------------------------------

export type Provider = 'codex' | 'claude';

/**
 * Which provider a model-policy class reasons on, per the 2026-09-04 13:20 decision: the
 * runtime master and planner run on gpt-6-astra through Codex, read-only, with Claude as
 * fallback and critic; everything that implements, verifies, researches, audits or
 * evaluates runs on Claude. A class this map does not name defaults to `claude`, which is
 * every class today except `master` and `plan`, the two the 13:20 decision named.
 */
export const CLASS_PROVIDERS: Record<string, Provider> = {
  master: 'codex',
  plan: 'codex',
};

export function providerFor(className: string): Provider {
  return CLASS_PROVIDERS[className] ?? 'claude';
}

export interface Reasoner {
  provider: Provider;
  call(input: { className: string; prompt: string }): Promise<{ text: string }>;
}

// ---------------------------------------------------------------------------------------
// ExternalWrite
// ---------------------------------------------------------------------------------------

export const EXTERNAL_WRITE_STATES = ['intent', 'call', 'complete', 'unknown'] as const;

export type ExternalWriteState = (typeof EXTERNAL_WRITE_STATES)[number];

/**
 * One write to a system Forge does not control: a Jira comment, a GitHub PR, a Slack
 * message. `intent` is recorded before the call is even attempted, so a crash between
 * intent and call is visible as an intent with no matching call rather than nothing at
 * all. `unknown` is what a write becomes when the call throws or times out and nobody
 * knows whether the other side received it. Reconciliation (checking whether the write
 * actually landed) has to happen before that write is ever retried, or a comment gets
 * posted twice.
 */
export interface ExternalWrite {
  id: string;
  kind: string;
  idempotencyKey: string;
  state: ExternalWriteState;
  at: number;
  cause?: string;
}

export const ExternalWriteSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  idempotencyKey: z.string().min(1),
  state: z.enum(EXTERNAL_WRITE_STATES),
  at: z.number(),
  cause: z.string().optional(),
});

/**
 * `unknown` and `call` may never be retried directly: a reconciler has to look at the
 * external system first. Only `intent` (nothing was ever sent) is safe to retry as-is.
 */
export function mayRetryWithoutReconciling(write: ExternalWrite): boolean {
  return write.state === 'intent';
}

// ---------------------------------------------------------------------------------------
// Redact
// ---------------------------------------------------------------------------------------

export type Redact = (text: string) => string;

/**
 * Shapes that read as a live credential rather than a normal error string. Conservative on
 * purpose: a false positive here masks a harmless string, a false negative leaks a secret,
 * and the second is the one this exists to prevent.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /AKIA[0-9A-Z]{16}/g,
];

/** Applied before every sink: gotcha files, exec dumps, `forge_report` rows. */
export const redact: Redact = (text) => {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
};

// ---------------------------------------------------------------------------------------
// StuckSignal, extended with drift and a blocker record
// ---------------------------------------------------------------------------------------

export type ExtendedLivenessSignal = LivenessSignal | 'drift' | 'blocker';

/** A blocker's own identity, so Warden can build on `liveness.ts` rather than beside it. */
export interface BlockerRecord {
  key: string;
  what: string;
  since: number;
}

export interface ExtendedStuckSignal extends Omit<StuckSignal, 'signal'> {
  signal: ExtendedLivenessSignal;
  blocker?: BlockerRecord;
}

export const ExtendedStuckSignalSchema = z.object({
  key: z.string().min(1),
  signal: z.enum(['idle', 'tool-budget', 'context', 'stale-session', 'login-stuck', 'fleet-unknown', 'drift', 'blocker']),
  threshold: z.number(),
  observed: z.number(),
  since: z.number(),
  hint: z.string(),
  blocker: z.object({ key: z.string().min(1), what: z.string().min(1), since: z.number() }).optional(),
});

/** Re-exported for anything importing the extension that also needs the class budgets. */
export { CLASS_BUDGETS, DEFAULT_CLASS };

// ---------------------------------------------------------------------------------------
// Inbox message states and AskEntry (the goal/run/action/resource/wording key)
// ---------------------------------------------------------------------------------------

export const INBOX_MESSAGE_STATES = ['queued', 'offered', 'delivered', 'acknowledged'] as const;

export type InboxMessageState = (typeof INBOX_MESSAGE_STATES)[number];

export interface InboxMessageEnvelope {
  id: string;
  state: InboxMessageState;
  at: number;
  from: string;
  text: string;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

export const InboxMessageSchema = z.object({
  id: z.string().min(1),
  state: z.enum(INBOX_MESSAGE_STATES),
  at: z.number(),
  from: z.string().min(1),
  text: z.string(),
  deliveredAt: z.number().optional(),
  acknowledgedAt: z.number().optional(),
});

export interface AskInput {
  goal: string;
  run: string;
  action: string;
  resource: string;
  wording: string;
}

/**
 * An ask's identity. `inbox.ts`'s own `askKey` today hashes wording and options only,
 * which is exactly the falsifier the spec's version closes: two different runs asking the
 * same words about different resources ("dev or staging" for two different services)
 * must never collide. Wording alone is never enough; goal, run, action and resource all
 * enter the hash, and case and internal whitespace are normalised out because they carry
 * no decision.
 */
export function askKey(input: AskInput): string {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const payload = [
    norm(input.goal), norm(input.run), norm(input.action), norm(input.resource), norm(input.wording),
  ].join('\u241F');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export interface AskEntry {
  key: string;
  goal: GoalId;
  run: RunId;
  action: string;
  resource: string;
  wording: string;
  options?: string[];
  kind: 'question' | 'blocker';
  at: number;
  answer?: string;
  answeredAt?: number;
}

export const AskEntrySchema = z.object({
  key: z.string().min(1),
  goal: z.string().min(1),
  run: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  wording: z.string().min(1),
  options: z.array(z.string()).optional(),
  kind: z.enum(['question', 'blocker']),
  at: z.number(),
  answer: z.string().optional(),
  answeredAt: z.number().optional(),
});

// ---------------------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------------------

/**
 * Every subcommand `cli.ts` answers today (`up`, `status`, `run`, `send`, `answer`,
 * `stop`, `gotchas`, `clear`, `cutover`), plus `why`, named in the spec's CLI-surface
 * bullet as part of the intended surface, not yet implemented on `main`. A stream that
 * adds `why` implements against this union; a stream that removes a command that is still
 * here breaks this file's specimen instead of a caller finding out at the terminal.
 */
export const CLI_COMMANDS = [
  'up', 'status', 'run', 'send', 'answer', 'stop', 'gotchas', 'clear', 'cutover', 'why',
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];
