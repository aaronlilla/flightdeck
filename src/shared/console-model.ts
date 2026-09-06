/**
 * The console model: the shapes the Flightdeck board renders and the routes that
 * carry them. Shared by the server (`src/forge/console/**`, which computes them from
 * the journal, the registry and the policy) and the browser console (`src/console/**`,
 * which renders them and never translates a server-internal shape itself).
 *
 * Every value the board shows is either verified or observed. A value is verified when
 * the feed is up and its source emitted a heartbeat less than `VERIFIED_WINDOW_MS` ago;
 * otherwise it is observed, and the tile that owns it says so. Freshness is computed per
 * value from `observedAt` / `verifiedAt`, never per page.
 */

export const VERIFIED_WINDOW_MS = 15_000;
export const HEARTBEAT_MS = 5_000;

export type LaneState =
  | 'running'
  | 'handed-off'
  | 'paused'
  | 'parked'
  | 'done'
  | 'merged'
  | 'blocked'
  | 'exhausted'
  | 'killed'
  | 'unverified';

/** poll, provision, launch, gate, merge, jira */
export type Hop = 0 | 1 | 2 | 3 | 4 | 5;
export const HOP_NAMES = ['poll', 'provision', 'launch', 'gate', 'merge', 'jira'] as const;

export interface LanePr {
  no: number;
  url: string;
  files: number;
  add: number;
  del: number;
  draft: boolean;
}

export interface LaneQuestion {
  /** The inbox key `POST /answer` takes. */
  key: string;
  text: string;
  opts: string[];
  askedAt: number;
}

export interface LaneSandbox {
  id: string;
  path: string | null;
  branch: string | null;
  pid: number | null;
  sessionId: string | null;
  /** No cloud sandbox exists to name a region for, so this is `'local'` rather than a
   *  fabricated AWS region string. */
  region: string | null;
  /** `${process.platform}/${process.arch}` of the machine running this worktree, the
   *  nearest real fact to the prototype's EC2 instance type. */
  instanceType: string | null;
}

export type SandboxLogSeverity = 'info' | 'progress' | 'retry' | 'error';

export interface SandboxLogLine {
  text: string;
  severity: SandboxLogSeverity;
}

export interface Lane {
  /** The run name (registry slug). */
  id: string;
  ticket: string | null;
  /** Short alias: `sonnet-5`, `opus-5`, `haiku-4.5`. Full id in `modelId`. */
  model: string;
  modelId: string | null;
  className: string | null;
  repo: string | null;
  attempt: number;
  state: LaneState;
  /** Why the lane is in `blocked` / `needs you`, when the server knows. */
  reason: string | null;
  stepN: number;
  stepTotal: number;
  stepText: string;
  ctxTokens: number;
  ctxCeiling: number;
  ctxCompactAt: number;
  /** Real, cumulative token usage for this run (every model call: input + output +
   *  cache read + cache write), never a dollar figure -- this fleet runs on a flat
   *  subscription, so no dollar is ever actually spent, and a `$` readout here would
   *  be fiction wearing a number's shape. */
  tokens: number;
  tokenCap: number | null;
  tokensPerMin: number;
  fails: number;
  hop: Hop;
  hopStatus: 'live' | 'done' | 'blocked';
  /** Last time any source reported on this run (journal event, lane file, registry). */
  observedAt: number;
  /** Last heartbeat from the run itself; null when the run never emitted one. */
  verifiedAt: number | null;
  /** Whether this run is expected to emit heartbeats in its current state. */
  heart: boolean;
  /** When the lane entered its current state. */
  since: number;
  startedAt: number;
  endedAt: number | null;
  question: LaneQuestion | null;
  pr: LanePr | null;
  sandbox: LaneSandbox | null;
  /** Integration id this lane is blocked on, when it is. */
  blockedBy: string | null;
  runaway: boolean;
  needsAaron: string | null;
}

export interface Feed {
  live: boolean;
  lostAt: number | null;
  reason: string | null;
  retryInS: number | null;
  lastHeartbeatAt: number | null;
}

export interface LanesResponse {
  at: number;
  lanes: Lane[];
  /** Total tokens burned since local midnight, and the burn of everything running now. */
  tokensToday: number;
  tokensPerMin: number;
}

export type MessageType =
  | 'event'
  | 'operator'
  | 'reply'
  | 'question'
  | 'plan'
  | 'confirm'
  | 'receipt'
  | 'refusal'
  | 'pr'
  | 'thinking';

export interface MessageButton {
  label: string;
  /** A command the composer would accept, sent back through `POST /command`. */
  cmd: string;
  cls?: 'go' | 'answer' | 'destroy' | 'defer';
}

export interface PlanItem {
  text: string;
  irreversible: boolean;
}

export interface Message {
  k: string;
  type: MessageType;
  text: string;
  ts: number;
  /** `conductor`, `operator`, `system`, or a lane id. */
  source: string;
  lane?: string;
  jid?: string;
  askKey?: string;
  opts?: string[];
  answer?: string;
  btns?: MessageButton[];
  items?: PlanItem[];
  /** One line of blast radius on a confirm card. */
  blast?: string;
  pr?: LanePr;
  resolved?: 'confirmed' | 'declined' | 'ran' | 'answered';
  undoable?: boolean;
  undone?: boolean;
  /** Freshness of the fact behind an event chip. */
  verifiedAt?: number | null;
}

export interface ThreadResponse {
  messages: Message[];
}

export interface JournalEntry {
  jid: string;
  ts: number;
  kind: string;
  text: string;
  actor: string;
  run: string | null;
  undoable: boolean;
  undone: boolean;
}

export interface JournalResponse {
  rows: JournalEntry[];
  total: number;
}

export type IntegrationStatus = 'ok' | 'down' | 'degraded' | 'off' | 'busy' | 'checking';

export interface Integration {
  id: string;
  kind: 'conn' | 'mcp';
  name: string;
  desc: string;
  latencyMs: number | null;
  status: IntegrationStatus;
  checkedAt: number;
  since: number | null;
  cause: string | null;
  effect: string | null;
  fix: string | null;
  fixLabel: string | null;
  /** A real, runtime-read scope for this row (an AWS profile, a Jira site), for the
   *  down-plate's scope chip. Null for a row with no such scope of its own. */
  scope: string | null;
  /** The last time this row's probe came back `ok`. Null until it has, at least once. */
  lastHealthyAt: number | null;
  /** Consecutive non-`ok` probe results since the last `ok` one. */
  retryCount: number;
  /** Lanes blocked on this integration. */
  dependents: string[];
  /** Reconnect progress 0..3 while a reconnect runs. */
  step: number | null;
  links: { tools?: string; logs?: string; manage?: string };
}

export interface IntegrationsResponse {
  items: Integration[];
  checkedAt: number;
  /** Seconds between automatic checks. */
  everyS: number;
}

export interface ReconnectResponse {
  ok: boolean;
  integration: Integration;
  steps: { text: string; done: boolean }[];
  message: string;
  jid: string | null;
}

export interface Caps {
  /** Every field here is a token count, not a dollar figure -- this fleet runs on a
   *  flat subscription, so a `$` cap here was always fiction wearing a number's shape.
   *  Unset (no console override, and nothing this file can honestly derive from the
   *  policy's own dollar-denominated defaults) reads as `Infinity`, never a guessed
   *  token figure. */
  dailyTokens: number;
  runTokens: number;
  hardTokens: number;
  enforcement: 'on' | 'off';
  tokensToday: number;
  /** Per-run overrides the operator set from the console. */
  overrides: Record<string, number>;
  /** Where each top-level figure came from: `console` once the operator has set it from
   *  here (`~/.forge/console/caps.json`), `policy` while none has been set (for
   *  `hardTokens` with neither set, 5x the effective daily cap). Lets the caps sheet say
   *  which numbers are actually theirs to change. */
  sources: Record<'dailyTokens' | 'runTokens' | 'hardTokens', 'policy' | 'console'>;
}

export interface Rule {
  id: string;
  kind: string;
  title: string;
  summary: string;
  evidence: string;
  effect: string;
  status: 'open' | 'applied' | 'dismissed';
  jid: string | null;
  prUrl: string | null;
  /** Whether this rule's evidence starts expanded on load. Only the top proposal ships
   *  this true; every other rule starts collapsed. */
  expanded?: boolean;
}

export interface ReviewMetrics {
  mergedToday: number;
  humanWaitMin: number;
  tokensPerMerge: number | null;
  /** Tokens spent on runs whose last state today is killed, blocked or exhausted --
   *  never a dollar figure. */
  tokensWasted: number;
}

export interface ProposalsResponse {
  rules: Rule[];
  metrics: ReviewMetrics;
  computedAt: number;
}

export interface ActionResult {
  ok: boolean;
  jid: string | null;
  message: string;
  undoable: boolean;
  lane?: Lane;
}

export interface CommandResponse {
  /** The cards the rail appends, already persisted to the thread. */
  cards: Message[];
}

export interface RunPrResponse {
  pr: LanePr | null;
}

export interface RunSandboxResponse {
  sandbox: LaneSandbox | null;
  log: SandboxLogLine[];
}

export interface RunThreadResponse {
  messages: Message[];
}

/** One row of the cost sheet's "by step" table: what one turn actually used, straight
 *  off the journal's own usage rows -- no list-price multiplication. */
export interface CostStep {
  t: number;
  stepText: string;
  inputTokens: number;
  outputTokens: number;
  /** `inputTokens + outputTokens` plus this turn's cache read/write, when either is
   *  billed under a raw token count rather than a dollar amount. */
  tokens: number;
}

export interface RunCostResponse {
  steps: CostStep[];
  /** The jid of the last `rule.enforced` decision this run recorded, only when the run
   *  is still runaway despite it -- the cap sheet's real analog of the prototype's
   *  fabricated "cap event failed (J-40211)" line. `null` when no such attempt is on
   *  record, which the sheet renders as no line at all rather than a made-up one. */
  capEnforcementFailedJid: string | null;
}

/** One line of the ticket sheet's journal panel: the run's own timeline, not the
 *  thread's reply/receipt cards. `color` is a CSS custom-property reference
 *  (`var(--ink2)` etc.), matching how the rest of the console carries state color. */
export interface JournalNarrativeEntry {
  t: number;
  text: string;
  color: string;
}

export interface RunJournalResponse {
  entries: JournalNarrativeEntry[];
}

/**
 * The routes. Reads carry the token like every other read except `/state`; writes carry
 * it and are refused without it. Every write journals a row and returns its jid.
 *
 * Reads
 *   GET  /lanes                          LanesResponse
 *   GET  /thread                         ThreadResponse   (the Conductor rail, persisted)
 *   GET  /journal?since=&run=&limit=     JournalResponse
 *   GET  /integrations                   IntegrationsResponse
 *   GET  /caps                           Caps
 *   GET  /proposals                      ProposalsResponse
 *   GET  /run/:id/thread                 RunThreadResponse
 *   GET  /run/:id/pr                     RunPrResponse
 *   GET  /run/:id/sandbox                RunSandboxResponse
 *   GET  /run/:id/cost                   RunCostResponse
 *   GET  /run/:id/journal                RunJournalResponse
 *   WS   /events                         frames; `{type:'heartbeat', at}` every HEARTBEAT_MS
 *
 * Writes
 *   POST /run/:id/kill      {reason}     ActionResult   irreversible
 *   POST /run/:id/pause     {reason?}    ActionResult   undoable (resume)
 *   POST /run/:id/resume    {}           ActionResult
 *   POST /run/:id/merge     {}           ActionResult   irreversible; runs the gate with merge
 *   POST /run/:id/reopen    {}           ActionResult
 *   POST /run/:id/compact   {}           ActionResult   hand off at the ceiling, resume successor
 *   POST /run/:id/verify    {}           ActionResult   runs the gate without merge
 *   POST /run/:id/cap       {tokenCap}   ActionResult   undoable
 *   POST /caps              {dailyTokens?, runTokens?}  Caps | 422 {error, hardTokens}   undoable
 *   POST /command           {text}       CommandResponse
 *   POST /integrations/:id/check         IntegrationsResponse
 *   POST /integrations/:id/reconnect     ReconnectResponse
 *   POST /proposals/:id/apply            ActionResult   undoable
 *   POST /proposals/:id/dismiss          ActionResult   undoable (restore)
 *   POST /proposals/:id/restore          ActionResult
 *   POST /journal/:jid/undo              ActionResult
 *
 * A write whose mechanism does not exist yet answers 501 `{error, reason}`; the rail
 * renders that as a refusal card and never pretends the action ran.
 */
export const CONSOLE_ROUTES = [
  '/lanes', '/thread', '/journal', '/integrations', '/caps', '/proposals', '/command',
] as const;
