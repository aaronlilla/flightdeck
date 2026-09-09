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

import { buildForgeMcpServer, FORGE_ASK_SHAPE, type ForgeToolHandlers } from '../adapter/engine.js';
import type { GotchaInput } from './gotcha.js';
import { CLASS_BUDGETS, DEFAULT_CLASS } from './exec.js';
import type { FleetProcess, LivenessSignal, StuckSignal } from './liveness.js';
import { LANE_FIELDS, type LaneRecord as BaseLaneRecord } from './supervisor.js';
import { providerFor as policyProviderFor } from './policy.js';
import type { RegistryRecord } from './registry.js';

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

/**
 * A `RunId`, composed the way the spec states it: goal plus attempt. `worker.ts`'s own
 * successor naming (`${run}-${index + 2}`) is exactly this shape today; this is that
 * composition made explicit and typed, so a caller builds a `RunId` from its parts
 * instead of hand-rolling the same string template a second time.
 */
export function makeRunId(goal: GoalId, attempt: number): RunId {
  return asRunId(attempt <= 1 ? goal : `${goal}-${attempt}`);
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

/**
 * `registry.ts`'s own `RegistryRecord`, re-typed here so `forge up`'s admission and
 * reconciliation rows have a runtime check where they cross a process boundary (the
 * JSON file `Registry.admit`/`setSession` write and `Registry.get` parses back). The
 * type is imported rather than copied: a field `registry.ts` renames breaks this
 * schema's callers instead of drifting silently from it.
 */
export type RegistryRow = RegistryRecord;

export const RegistryRowSchema = z.object({
  goal: z.string().min(1),
  cwd: z.string().min(1),
  briefPath: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.number().int().positive(),
  sessionId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}) satisfies z.ZodType<RegistryRow>;

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
  // Written today, confirmed by the scan specimen below over src/forge/**. Includes
  // B.3's own rows (`run.resumed`, `inbox.acknowledged`, `warden.parked`), which are on
  // `main` as of PR #3 (5385179) and are no longer merely proposed.
  'ask.answered', 'ask.raised', 'console.unhandled', 'cutover.completed', 'cutover.moved', 'engine.error',
  'forge.ask', 'forge.done', 'forge.handoff', 'forge.report', 'gotcha', 'inbox.acknowledged',
  'inbox.delivered', 'liveness.cleared', 'liveness.stuck', 'note', 'permission.denied',
  'run.blocked', 'run.finished', 'run.handoff', 'run.parked', 'run.paused', 'run.resumed',
  'run.started', 'run.verify-failed', 'subagent.usage', 'tool.end', 'tool.start', 'turn.end',
  'warden.parked',
  // The spec's additions (the "Contracts" paragraph of the 2026-09-04 13:45 refined
  // build-out plan) that nothing writes yet. `policy.unknown-model` is B.3.9's own,
  // named in the brief but not yet emitted: `journal.ts` tracks unpriced models in
  // `FleetState.unknownModels` today rather than journaling a row.
  'inbox.queued', 'inbox.offered', 'stuck', 'cleared', 'blocker.raised', 'blocker.cleared',
  'external.intent', 'external.complete', 'external.unknown', 'decision.made',
  'source.observed', 'packet.written', 'policy.unknown-model',
  // Warden's own additions (roadmap P4.1): a kill Actuator.kill actually carried out,
  // a kill it refused for lack of a decision, and a fleet-probe health note that is never
  // acted on (liveness.ts's fleet-unknown, surfaced but not treated as a run's own fault).
  'run.killed', 'warden.refused', 'warden.health',
  // The console's own liveness ticker (`server.ts`): a websocket-only push, never
  // journaled, telling a connected board that one lane's own process just flipped
  // alive or dead between polls.
  'lane.live',
  // The Governor stream's own (roadmap P4.2, `src/forge/governor.ts`): `result.usage`
  // carries the SDK result message's own `modelUsage` map, journaled by the engine on a
  // segment's end row; `burn.mismatch` is the reconciliation between that sum and B.3.6's
  // per-message sum; `governor.parked` is a budget-cap park, kept apart from
  // `warden.parked`'s model-mismatch park even though both use the same `run.parked`
  // liveness fold, so a reader can tell a cap from a mismatch without inspecting `reason`.
  'result.usage', 'burn.mismatch', 'governor.parked',
  // P4.7/I4: the Council rules library's own verdict, once wired into the worker's
  // PreToolUse hook -- a Bash or Edit/Write call the rules library refused, distinct
  // from `permission.denied` (a park or the context ceiling) so a reader can tell a
  // policy refusal from a liveness one without inspecting `reason`.
  'rule.denied',
  // X4, the console's rail-thread router: 'intake.requested' for new work the router
  // handed to Intake, 'proposal' for a system-instruction message the act step read as
  // a suggestion rather than a bug report (`gotcha` above already covers the other
  // reading of that same class).
  'intake.requested', 'proposal',
  // The Self-iteration stream's own (roadmap P4.6): `gotcha.clustered` marks a group of
  // gotchas folded into one root cause; `proposal.opened` is a draft pull request filed
  // for one cluster, never a merge; `proposal.reverted-requested` is a revert PR asked
  // for after a merged proposal's canary failed, always opened by this code and always
  // merged by a person; `self-iteration.activated` is the one row `Activation`
  // (`self-iteration/decision.ts`) ever writes, and only once a `decision.made` row
  // naming the target and `activate` already exists.
  'gotcha.clustered', 'proposal.opened', 'proposal.reverted-requested', 'self-iteration.activated',
  // I11: `forge clear --phantoms` removing `runs/pid_N/` directories the Warden wrote
  // for a fleet process id that was never a registered run.
  'phantoms.cleared',
  // Item 4, 2026-09-05: `forge clear --stale` removing lane files whose chain finished
  // more than a day ago and whose registry row is gone.
  'lanes.cleared',
  // Item 8, 2026-09-05: `forge run --auto-answer` answering its own ask in-process, for
  // a probe or smoke run.
  'ask.auto-answered',
  // I12: `reconcileRegistry` dropping a dead-pid row with no session id, once it is old
  // enough to be a crash rather than a race against its own admission.
  'registry.abandoned',
  // I14: a continuation prompt the worker sends on its own open session when a segment
  // ends with no `forge_done`, no ceiling hit, no park and no kill -- before it gives up
  // and calls the run `stopped`.
  'run.nudged',
  // P4.7/I4: the `claude` provider (`reasoner-claude.ts`) behind the `Reasoner` seam.
  // `reasoner.call` covers both a parsed reply (`parsed: true`) and one that failed to
  // parse (`parsed: false`, with the raw text); `reasoner.timeout` is a call that
  // outran `reasoner.timeoutMs` and was abandoned rather than awaited further.
  'reasoner.call', 'reasoner.timeout',
  // I16: a base-drift blocker this run raised earlier clears when a later post-push
  // read finds the branch mergeable after all.
  'run.unblocked',
  // forge-council-live: `forge council`'s own rows -- one `council.lens` per lens
  // packet, one `council.judge` for the judge's verdict, one `council.attested` when
  // the attestation lands on disk. `external.call` fills the gap in the ExternalWrite
  // state machine's own journal trail (`intent` and `complete`/`unknown` already had
  // event names; `call` -- the write was attempted, outcome not yet known -- did not)
  // for `forge gate --merge`'s squash-merge call. `intake.planned` is `forge intake
  // --once`'s planner writing a goal brief for one queued packet.
  'council.lens', 'council.judge', 'council.attested', 'external.call', 'intake.planned',
  // F3, 2026-09-05: an inbox ask retired because none of its runs has a registry row
  // left -- moved to ~/.forge/inbox/retired/ by `forge clear --all`, never deleted.
  'inbox.retired',
  // Forge Jira stream (J3): `forge gate --merge` reached a completed merge whose PR
  // named a ticket, but FORGE_JIRA_SITE/EMAIL/TOKEN were not all set, so none of the
  // three handoff writes were attempted.
  'jira.skipped',
  // P5.7: the chain's own hop rows, one per packet -- `chain.blocked` when a hop cannot
  // proceed, `chain.provisioned`/`chain.launched` for H2/H3, `chain.gated` for the
  // council verdict H4 read, `chain.merged`/`chain.stopped` for how a gated packet
  // ended, and `chain.tick-error` for a tick that threw before any of those.
  'chain.blocked', 'chain.provisioned', 'chain.launched', 'chain.gated', 'chain.merged',
  'chain.stopped', 'chain.tick-error',
  // C2: `forge chain retry PACKET` -- clears a blocked packet's state so the next
  // tick runs the hop it stopped at again, the only way a `chain.blocked` packet ever
  // moves again once a person has looked at why.
  'chain.unblocked',
  // The intake queue's own hop rows (`intake/queue.ts`), one per item transition --
  // `queue.planning`/`queue.planned` for the plan hop, `queue.launched` for provision
  // and launch together, `queue.parked` for an unrouted repo, a non-`done` verdict, a
  // council that did not pass, or a finished run with no PR anywhere, `queue.failed`
  // for a hop that threw outright, `queue.review` once a draft PR exists, and
  // `queue.tick-error` for a worker tick that threw before any item advanced.
  'queue.planning', 'queue.planned', 'queue.launched', 'queue.parked', 'queue.failed',
  'queue.review', 'queue.tick-error',
  // The self-heal stream (B). `queue.paused`: the queue tick backs off to a 10 minute
  // drip after three identical consecutive `queue.tick-error`s in a row (B.1).
  // `run.relaunched`: a worker that died mid-tool gets resumed once on the same
  // worktree; a second death parks it for good (B.2). `registry.reaped`: a registry
  // row whose pid is provably gone, with a park record older than the 4 hour bound,
  // gets released with no process ever signalled (B.3). `chain.worktree.reclaimed`:
  // a `git worktree add` that found a branch already checked out with no live
  // registry row behind it removes that worktree and retries the add once, instead
  // of blocking the whole packet forever (B.4).
  'queue.paused', 'run.relaunched', 'registry.reaped', 'chain.worktree.reclaimed',
  // C.1: `POST /amend` correcting a running item's brief mid-flight (adding only this one
  // name here -- this file is shared across streams).
  'brief.amended',
  // F, 2026-09-07: the self-iteration stream's own rows (`src/forge/self/**`).
  // `self.finding` for one `SelfFinding` `analyze()` surfaced; `self.enqueued` when a
  // finding becomes a queue item; `self.merged`/`self.merge-refused` for
  // `selfMergeAllowed`'s own decision on a self-repo item; `self.restart` when
  // `cutoverDue` finds the fleet idle on a moved `origin/main` and pulls it in.
  'self.finding', 'self.enqueued', 'self.merged', 'self.merge-refused', 'self.restart', 'self.tick-error', 'queue.unverified-pr',
  // H1.7: a lane moved off (or back onto) the board's default view by an operator's own
  // Retire/Unretire click or the bulk `POST /retire-finished` -- never written by any
  // worker or automation.
  'lane.retired',
  // The Conductor agent (2026-09-08): one usage row per model turn on the rail, and one
  // live-feed frame per tool receipt so the console refetches the thread mid-turn.
  'conductor.usage', 'conductor.receipt',
  // The Conductor's rounds (2026-09-08, `console/rounds-route.ts`): one sheet row per
  // walk whose findings changed (dry run) or per walk that acted, and one row per action
  // it applied through the queue's own functions.
  'rounds.sheet', 'rounds.applied',
  // H1.8: one lane's own outcome from the bulk `POST /merge-ready` -- always an
  // operator's own click, never a worker acting on its own.
  'merge-ready.merged',
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
 *
 * `seq` and `version` are required here because the spec asks for them. `Journal.append`
 * and `appendOnce` (`journal.ts`) stamp both on every row as of the reconcile pass that
 * closed this gap: `seq` monotonic per journal file, `version: 1`, neither overridable
 * by a caller's own event fields. A journal written before that change carries rows with
 * neither field; `replayEvents` reads those as `version: 0` with a locally-assigned
 * `seq`, rather than quarantining every pre-existing line the day this shipped.
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
  // Rows written before `Journal.append` stamped `seq`/`version` (pre-B.3 history) carry
  // neither field. The schema stays strict -- it still requires both -- so a legacy row
  // is backfilled with a locally-assigned seq and `version: 0` before validation, rather
  // than the schema being loosened to make the fields optional for everyone.
  let legacySeq = -1;

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
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const record = row as Record<string, unknown>;
      if (typeof record.seq !== 'number') {
        legacySeq += 1;
        record.seq = legacySeq;
      }
      if (typeof record.version !== 'number') record.version = 0;
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
// StuckSignal, extended with drift and a blocker record
// ---------------------------------------------------------------------------------------

export type ExtendedLivenessSignal = LivenessSignal | 'drift' | 'blocker' | 'cost-shape';

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
  signal: z.enum([
    'idle', 'tool-budget', 'context', 'stale-session', 'login-stuck', 'fleet-unknown', 'drift',
    'blocker', 'cost-shape',
  ]),
  threshold: z.number(),
  observed: z.number(),
  since: z.number(),
  hint: z.string(),
  blocker: z.object({ key: z.string().min(1), what: z.string().min(1), since: z.number() }).optional(),
});

/** Re-exported for anything importing the extension that also needs the class budgets. */
export { CLASS_BUDGETS, DEFAULT_CLASS };

/**
 * One fleet process, matched to `liveness.ts`'s own `FleetProcess`. Declared here (ahead
 * of `/state`, which needs it) rather than beside the imported type, because a zod schema
 * for an imported interface has nowhere more natural to live than next to the extended
 * signal it is checked alongside.
 */
export const FleetProcessSchema = z.object({
  pid: z.number().int(),
  isLogin: z.boolean(),
  credentialsMtime: z.number().optional(),
  sessionFileMtime: z.number().optional(),
});

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
  stuck: VerifiedFieldSchema(z.array(ExtendedStuckSignalSchema)),
  fleet: VerifiedFieldSchema(z.union([
    z.array(FleetProcessSchema),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ])),
  runs: z.record(z.string(), z.object({
    run: z.string().min(1),
    lastEventAgeS: z.number(),
    inFlightTools: z.array(z.object({ id: z.string(), name: z.string(), startedAt: z.number() })),
    openStuck: z.array(ExtendedStuckSignalSchema),
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
export const ForgeAskInputSchema = z.object(FORGE_ASK_SHAPE);
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
  /**
   * Resolves `true` when the run was actually parked (a registry row or a lane backs
   * it), `false` when the target is unregistered and the actuator refused instead,
   * journaling `warden.refused` itself and touching nothing on disk (I11/I11b). A
   * caller deciding which event to journal must use this return value, never a
   * registration check it computed itself earlier: two separate reads of the same
   * registry, one before this call and one inside it, can disagree on a live fleet.
   */
  park(run: RunId, reason: string): Promise<boolean>;
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
/**
 * A seventh role, additive (decision 4, `2026-09-04-forge-self-iteration.md`): the
 * Self-iteration stream clusters gotchas and drafts pull requests, and neither task
 * belongs to any of the original six. Nothing about the original six changes here --
 * `intake` still means intake, `runner` still means runner.
 */
export const EVENT_BUS_ROLES = [
  'intake', 'governor', 'runner', 'warden', 'council', 'console', 'self-iteration',
] as const;

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
 * evaluates runs on Claude.
 *
 * P4.7/I3: this used to be its own hardcoded `CLASS_PROVIDERS` map, a second copy of
 * exactly the fact `policy.ts`'s data-driven `providerFor` already reads out of
 * `model-policy.json` for the Governor stream (P3.2). Two copies of one fact is the
 * failure this integration exists to close (order 17's own $6,250 lesson), so this
 * delegates to the file rather than carrying its own frozen snapshot of it. A class the
 * loaded policy has never heard of still reads as `claude` here -- `policy.ts`'s own
 * `providerFor` throws for that case, by design, since guessing a provider for a class
 * nobody declared would carry the policy's authority for a fact it never stated; this
 * wrapper is the one place that guess is made instead, for every caller that expects a
 * graceful default rather than a thrown class-not-found.
 */
export function providerFor(className: string): Provider {
  try {
    return policyProviderFor(className);
  } catch {
    return 'claude';
  }
}

export interface Reasoner {
  provider: Provider;
  /**
   * `replyShape` says what the caller can already accept back, beyond the default
   * JSON-object reply every class required before I19. Pass `'array'` for a lens, whose
   * whole answer is a findings array (`reasonerRoles.ts`'s own prompt asks for one): a bare
   * JSON array, fenced or not, then parses instead of being rejected just for arriving
   * unwrapped rather than inside `{"text": ...}`. Leave it unset, or pass `'object'`, and
   * every other class keeps the original object-only behavior.
   */
  /**
   * `run` is optional: only a caller that already knows which run or PR it is reasoning
   * about (`ConformanceDrift.check`, the council's lens and judge roles) can pass one,
   * and it exists purely so the journal row for the call carries it -- `Reasoner` itself
   * does nothing differently whether it is present or not. Item 7, 2026-09-05: without
   * it, a reasoner spend had no way to be attributed to the run or PR that caused it.
   */
  call(
    input: { className: string; prompt: string; replyShape?: 'object' | 'array'; run?: string },
  ): Promise<{ text: string }>;
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
  /** Defaults to `'question'`. A question and a blocker over the same words are two asks. */
  kind?: 'question' | 'blocker';
}

/**
 * An ask's identity. `inbox.ts`'s own `askKey` today hashes wording and options only,
 * which is exactly the falsifier the spec's version closes: two different runs asking the
 * same words about different resources ("dev or staging" for two different services)
 * must never collide. Wording alone is never enough; goal, run, action, resource and kind
 * all enter the hash (a question and a blocker carrying identical words are still two
 * different asks), and case and internal whitespace are normalised out because they carry
 * no decision.
 *
 * The five fields are JSON-encoded into one array before hashing rather than joined on a
 * separator character: a joined string can be pried apart by a field that happens to
 * contain the separator, and `JSON.stringify` already escapes exactly that.
 */
export function askKey(input: AskInput): string {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const payload = JSON.stringify([
    norm(input.goal), norm(input.run), norm(input.action), norm(input.resource), norm(input.wording),
    input.kind ?? 'question',
  ]);
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

/**
 * `forge run`'s exit codes, per B.3.4: 0 done, 1 refused (the launch never started), 2
 * parked (an ask, a ceiling, or a stuck trip), 3 exhausted or stopped. Declared here so
 * `cli.ts` reads its own exit codes off a shared name instead of a bare number a second
 * caller could read differently.
 */
export const CLI_EXIT_CODES = {
  done: 0,
  refused: 1,
  parked: 2,
  exhaustedOrStopped: 3,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

// ---------------------------------------------------------------------------------------
// Intake (P4.3): PollSource, Watermark, Packet — additive only, per decision 4 of the
// 2026-09-04 Intake brief. Nothing above this section changes; every export below is new.
// ---------------------------------------------------------------------------------------

/**
 * The five sources the spine spec names for Intake to poll (Section 2, bullet 1). Closed
 * on purpose, the same reasoning as `FORGE_EVENT_NAMES`: a caller that wants a sixth
 * source adds it here first.
 */
export const POLL_SOURCE_NAMES = ['jira', 'sentry', 'cloudwatch', 'slack', 'github'] as const;

export type PollSourceName = (typeof POLL_SOURCE_NAMES)[number];

/**
 * One item read off a poll: which source it came from, that source's own id for it
 * (a Jira key, a Sentry short id, a CloudWatch query result row's fingerprint, a Slack
 * message ts, a GitHub comment id), and the `updated` timestamp the watermark advances
 * on. `source + id + updated` is exactly the key requirement 8 asks `source.observed` to
 * carry, so this shape is what that event's payload is built from.
 */
export interface PollSource {
  name: PollSourceName;
  id: string;
  updated: number;
}

export const PollSourceSchema = z.object({
  name: z.enum(POLL_SOURCE_NAMES),
  id: z.string().min(1),
  updated: z.number(),
});

/**
 * The durable-commit half of watermark semantics (requirement 1): the last `updated`
 * value a poll has fully processed, plus every id it saw AT that exact value.
 *
 * The ids-at-committed-at list is what makes equal timestamps safe: a page boundary
 * that lands mid-tie (two Jira issues sharing one `updated` millisecond) is resolved by
 * checking id membership at the tie value, not by re-processing everything at or after
 * it. A crash before this is written leaves the previous commit in force, which is what
 * makes "durable commit after a full scan" (roadmap:113) an atomic swap rather than a
 * value updated as pages stream in.
 */
export interface Watermark {
  source: PollSourceName;
  committedAt: number;
  idsAtCommittedAt: string[];
}

export const WatermarkSchema = z.object({
  source: z.enum(POLL_SOURCE_NAMES),
  committedAt: z.number(),
  idsAtCommittedAt: z.array(z.string()),
});

export const PACKET_CONFIDENCE = ['low', 'medium', 'high'] as const;

export type PacketConfidence = (typeof PACKET_CONFIDENCE)[number];

/**
 * A findings packet, typed for the first time (it was informal in the spec: "what, where,
 * evidence, confidence, repo, blocked-by" — spine spec Section 2, bullet 2). One packet
 * per ticket/issue, written by a bounded triangulation run; nothing downstream re-derives
 * it, so its shape has to carry everything the planner and the Jira projection both need.
 */
export interface Packet {
  id: string;
  ticket: string;
  what: string;
  where: string;
  evidence: string[];
  confidence: PacketConfidence;
  repo: string;
  blockedBy: string[];
  at: number;
}

export const PacketSchema = z.object({
  id: z.string().min(1),
  ticket: z.string().min(1),
  what: z.string().min(1),
  where: z.string().min(1),
  evidence: z.array(z.string()),
  confidence: z.enum(PACKET_CONFIDENCE),
  repo: z.string().min(1),
  blockedBy: z.array(z.string()),
  at: z.number(),
});

// ---------------------------------------------------------------------------------------
// Council: verdicts, findings, and the attestation that binds a verdict to a commit pair
// ---------------------------------------------------------------------------------------

/**
 * Roadmap P4.4. The judge's three answers, per the spec's Section 5
 * (`2026-09-04-forge-spine-sdk-workers.md:143-145`): `FIX FIRST` re-enters the worker,
 * `PASS` and `PASS WITH NOTES` both clear the gate.
 */
export const COUNCIL_VERDICTS = ['PASS', 'PASS WITH NOTES', 'FIX FIRST'] as const;

export type CouncilVerdict = (typeof COUNCIL_VERDICTS)[number];

export const CouncilVerdictSchema = z.enum(COUNCIL_VERDICTS);

/**
 * One finding, in the shape `.claude/skills/council/council-workflow.js`'s own
 * `FINDINGS_SCHEMA` and `goal-forge-review.js`'s `FINDINGS` schema already use (file, line,
 * claim, failure scenario, severity, confidence), plus `member` so a synthesis can tell
 * which lens or which Codex run raised it.
 */
export interface CouncilFinding {
  member: string;
  file: string;
  line: number;
  claim: string;
  failureScenario: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'low' | 'medium' | 'high';
  /** Set when a Codex-only finding is contested rather than folded into the verdict. */
  contested?: { by: string; reason: string };
}

export const CouncilFindingSchema = z.object({
  member: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  claim: z.string().min(1),
  failureScenario: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  confidence: z.enum(['low', 'medium', 'high']),
  contested: z.object({ by: z.string().min(1), reason: z.string().min(1) }).optional(),
});

/** One lens's isolated packet: cites only, never another lens's findings (Section 5). */
export interface CouncilLensReport {
  lens: string;
  findings: CouncilFinding[];
  /** I19: set when this lens's reply could not be parsed at all, distinguishing "found
   *  nothing" from "could not answer". `findings` still carries one medium-severity
   *  finding describing the failure, so the judge and the attestation both see it even
   *  without reading this flag. */
  failed?: boolean;
  /** The raw reply that failed to parse, kept only when `failed` is true so the failure
   *  is diagnosable from the journal row without a repro. */
  rawReply?: string;
  /** GATE.md item 2: set once `orchestrate.ts` has given this lens its one retry after
   *  an initial failure, whatever the retry's own outcome was. `failed` on a `retried`
   *  report means the retry failed too, not that no retry was attempted. */
  retried?: boolean;
}

export const CouncilLensReportSchema = z.object({
  lens: z.string().min(1),
  findings: z.array(CouncilFindingSchema),
  failed: z.boolean().optional(),
  rawReply: z.string().optional(),
  retried: z.boolean().optional(),
});

/**
 * Attestation, P4.4's own deliverable (F25, `2026-09-04-forge-spine-sdk-workers.md:999-1004`):
 * nothing before this bound a council verdict to the commit pair it was actually about, so a
 * re-run against a moved head could be mistaken for the verdict that gated the merge.
 *
 * `head`/`base` are the two shas the merge gate compares against the PR's *current* shas
 * before trusting a stored attestation (decision 4): either moving invalidates it.
 * `at` carries the `VerifiedField` discipline the `/state` shapes use, so a stamped
 * timestamp with no read behind it is a distinct shape from one backed by a source read.
 */
export interface CouncilAttestation {
  repo: string;
  pr: number;
  head: string;
  base: string;
  round: number;
  verdict: CouncilVerdict;
  decidingFindings: CouncilFinding[];
  lenses: CouncilLensReport[];
  codex?: { ran: boolean; findings: CouncilFinding[] };
  judge: { model: string; verdict: CouncilVerdict };
  ci: { runId: string; headSha: string };
  at: VerifiedField<number>;
  /** GATE.md item 4: which members this round required and which of those never
   *  answered, even after a retry -- carried on the attestation itself so "reviewed by 2
   *  of 4" reads straight off this record rather than only being inferable from an
   *  absent finding. An attestation only ever exists for a verdict that cleared, so
   *  `missing` is always empty here in practice; the field still ships on every
   *  attestation, not only a short one, so a reader never has to wonder whether its
   *  absence means full coverage or an older record. */
  coverage: { total: number; missing: string[] };
}

export const CouncilAttestationSchema = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  head: z.string().min(1),
  base: z.string().min(1),
  round: z.number().int().positive(),
  verdict: CouncilVerdictSchema,
  decidingFindings: z.array(CouncilFindingSchema),
  lenses: z.array(CouncilLensReportSchema),
  codex: z.object({ ran: z.boolean(), findings: z.array(CouncilFindingSchema) }).optional(),
  judge: z.object({ model: z.string().min(1), verdict: CouncilVerdictSchema }),
  ci: z.object({ runId: z.string().min(1), headSha: z.string().min(1) }),
  at: VerifiedFieldSchema(z.number()),
  coverage: z.object({ total: z.number().int().nonnegative(), missing: z.array(z.string()) }),
});

/**
 * Where an attestation persists (decision 4). Declared here, not merely in the runner that
 * writes it, so a reader who only has `contracts.ts` open still knows the on-disk shape.
 * No drive letter: callers join this against whatever root they resolve `~/.forge` to.
 */
export function attestationRelPath(repo: string, pr: number, head: string): string {
  return `attestations/${repo}/${pr}/${head}.json`;
}

/**
 * An attestation is current for a PR only if both shas still match what it was written
 * against (decision 4's own rule, and acceptance specimen 7's falsifier: nothing in the
 * stored shape may leave the two head shas indistinguishable).
 */
export function attestationCoversHead(
  attestation: CouncilAttestation,
  current: { head: string; base: string },
): boolean {
  return attestation.head === current.head && attestation.base === current.base;
}

// ---------------------------------------------------------------------------------------
// Typed human handoffs (decision 7): an incomplete one fails the gate
// ---------------------------------------------------------------------------------------

/** Haiping (QA): the visual test plan a merged RN change hands him. */
export interface HaipingHandoff {
  ticket: string;
  pr: string;
  deployKind: 'ota' | 'rebuild';
  perPlatform: { android: string; ios: string };
  steps: string[];
  notVisuallyVerified: string[];
}

export const HaipingHandoffSchema = z.object({
  ticket: z.string().min(1),
  pr: z.string().min(1),
  deployKind: z.enum(['ota', 'rebuild']),
  perPlatform: z.object({ android: z.string().min(1), ios: z.string().min(1) }),
  steps: z.array(z.string().min(1)).min(1),
  notVisuallyVerified: z.array(z.string()),
});

/**
 * Q-56a42646 / PR #121: a worker with no access to flightdeck's own source cannot see
 * `HaipingHandoffSchema` above, so naming it in the brief left one worker inventing its
 * own fields. This builds the fenced example straight from a `HaipingHandoff` object
 * literal -- typechecked against the same interface the schema validates -- rather than
 * a second hand-written copy of the shape that could drift from it. Every value is an
 * obvious placeholder a worker overwrites, and it still parses as complete on its own:
 * `checkHandoff('haiping', JSON.parse(haipingHandoffExample()))` is `{ complete: true }`.
 */
export function haipingHandoffExample(): string {
  const example: HaipingHandoff = {
    ticket: 'BBZ-000',
    pr: 'owner/repo#0',
    deployKind: 'ota',
    perPlatform: { android: 'REPLACE: android fingerprint or build number', ios: 'REPLACE: ios fingerprint or build number' },
    steps: ['REPLACE: first thing Haiping should do', 'REPLACE: what he should see happen'],
    notVisuallyVerified: ['REPLACE: a step nobody looked at on a screen'],
  };
  return JSON.stringify(example, null, 2);
}

/** Joe: the backend draft-PR ping, since the gitflow guard makes a merge impossible. */
export interface JoeHandoff {
  ticket: string;
  draftPr: string;
  packets: CouncilLensReport[];
  howToRun: string;
  couldNotRun: string[];
}

export const JoeHandoffSchema = z.object({
  ticket: z.string().min(1),
  draftPr: z.string().min(1),
  packets: z.array(CouncilLensReportSchema).min(1),
  howToRun: z.string().min(1),
  couldNotRun: z.array(z.string()),
});

/** Harrison (PM): a proposal that needs a person's decision, never a merge itself. */
export interface HarrisonHandoff {
  ticket: string;
  summaryInAaronsVoice: string;
  decisionNeeded?: string;
}

export const HarrisonHandoffSchema = z.object({
  ticket: z.string().min(1),
  summaryInAaronsVoice: z.string().min(1),
  decisionNeeded: z.string().optional(),
});

export type HandoffKind = 'haiping' | 'joe' | 'harrison';

/**
 * Validate a handoff against its schema and report the field(s) missing rather than a bare
 * boolean, so the gate that refuses an incomplete handoff can say what is incomplete about
 * it (requirement: "an incomplete one fails the gate").
 */
export function checkHandoff(
  kind: HandoffKind,
  candidate: unknown,
): { complete: true } | { complete: false; missing: string[] } {
  const schema = kind === 'haiping' ? HaipingHandoffSchema : kind === 'joe' ? JoeHandoffSchema : HarrisonHandoffSchema;
  const result = schema.safeParse(candidate);
  if (result.success) return { complete: true };
  const missing = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
  return { complete: false, missing };
}
