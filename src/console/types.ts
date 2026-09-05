/**
 * Shapes the console reads today, copied from `src/forge/server.ts`,
 * `src/forge/supervisor.ts`, `src/forge/journal.ts` and `src/forge/inbox.ts`
 * on main (read, never imported: cut 1 does not touch `src/forge/**`).
 *
 * `VerifiedField` is the P3.1 contracts shape the console is built to expect
 * once `src/forge/contracts.ts` lands: `{ value, observed_at, verified_at?,
 * source }`, `verified_at` present only when the value came from an actual
 * source read. Today's real `/state` always stamps `verified_at` from an
 * in-memory clock, which is the known over-claim the contracts work fixes;
 * this type and the `Freshness` component render the distinction the moment
 * a field arrives without one, without waiting on that merge.
 */

export interface VerifiedField<T> {
  value: T;
  observed_at?: number;
  verified_at?: number;
  source?: string;
}

export type RunLifecycleState =
  | 'queued'
  | 'admitted'
  | 'running'
  | 'handing-off'
  | 'parked'
  | 'paused'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'killed';

export interface LaneRecord {
  slug: string;
  column: string;
  owner: string;
  session_id: string | null;
  claude_pid: number | null;
  started: number | null;
  ended: number | null;
  verdict: string | null;
  position: number | null;
  note: string | null;
  woken: number;
  model: string | null;
  context: number;
  cost_usd: number;
  handoff: string | null;
  needs_aaron?: string | null;
  /** Set by `server.ts#state()`, not stored on the lane file itself. */
  usd_per_hour: number;
  verified_at: number;
  last_event_age_s: number;
  current_tool: { name: string; startedAt: number } | null;
  goal?: string;
  className?: string;
  provider?: string;
  /** X1: the live run's own lifecycle state (`RunState['state']` in `journal.ts`), present
   *  only when a run for this slug has taken at least one turn. A tile prefers this over
   *  `verdict`/`column`, which describe whatever chain last finished, not what is running
   *  now -- the falsifier this closes is a parked chain's verdict rendering beside a run
   *  that is genuinely live. */
  run_state?: 'started' | 'finished' | 'handed-off' | 'paused' | 'parked';
}

/** One run's slice of `/state`, keyed by run (today, the lane's own slug). Mirrors
 *  `journal.ts`'s `RunState` on the fields the console reads. */
export interface ConsoleRunView {
  run: string;
  state: 'started' | 'finished' | 'handed-off' | 'paused' | 'parked';
  className?: string;
  model?: string;
  context: number;
  costUsd: number;
  currentTool?: { name: string; startedAt: number };
  lastEventAt: number;
  parkKey?: string;
  successor?: string;
  predecessor?: string;
}

export interface ForgeState {
  at: number;
  lanes: VerifiedField<LaneRecord[]>;
  burn: VerifiedField<Record<string, number>>;
  handoffs: VerifiedField<number>;
  torn: VerifiedField<number>;
  inbox_open: VerifiedField<number>;
  stuck: VerifiedField<unknown[]>;
  fleet: VerifiedField<Array<Record<string, unknown>> | { ok: false; reason: string }>;
  /** The contracts' `ForgeStateSnapshot.runs`: the journal's live view of every run,
   *  keyed by run. Optional so a fixture built before this field existed still typechecks. */
  runs?: Record<string, ConsoleRunView>;
  /** X4: whether `POST /router` will actually classify and act, read fresh from the
   *  policy file on every `/state` call. Optional so a fixture predating the router
   *  reads as "off" rather than throwing. */
  router_enabled?: boolean;
}

/** `POST /router`'s response shape (X4). */
export interface RouterResult {
  routed: boolean;
  reason?: string;
  outcome?: { class: string; [key: string]: unknown };
}

export interface InboxEntry {
  key: string;
  question: string;
  options: string[];
  kind: 'question' | 'blocker';
  runs: string[];
  asked: number;
  at: number;
  answer?: string;
  answeredAt?: number;
  disposition: 'park';
  ticket?: string;
}

export interface InboxState {
  open: InboxEntry[];
  all: InboxEntry[];
}

/** `GET /run/:id`'s shape (X3). `plan`, `prUrl`, `council` and `comments` are
 *  named explicitly as `null` rather than omitted so the ticket sheet can say
 *  "not wired" for a field nothing in the fleet writes yet, distinct from a
 *  field that failed to load. */
export interface RunDetail {
  run: string;
  packet: string | null;
  plan: string | null;
  prUrl: string | null;
  council: string | null;
  comments: string | null;
  provenance: { predecessor: string | null; successor: string | null };
  state: ConsoleRunView | null;
}

export interface ForgeEvent {
  id?: string;
  seq?: number;
  at?: number;
  event: string;
  run?: string;
  goal?: string;
  actor?: string;
  cause?: string;
  ticket?: string;
  [key: string]: unknown;
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';
