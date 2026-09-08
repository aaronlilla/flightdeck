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
  /** H1.3 fix: absent until the board has actually read the PR's own diff -- never a
   *  guessed 0. A tile with no `files`/`add`/`del` shows "files not read yet" rather
   *  than a fabricated empty diff. */
  files?: number;
  add?: number;
  del?: number;
  draft: boolean;
  /** The PR's own state as a person reads it on GitHub (2026-09-07): its checks, the
   *  council's last verdict on this head, and whether it has merged. Null fields mean
   *  the board has not read that fact yet, never that it is fine. */
  checks?: 'success' | 'failure' | 'pending' | null;
  verdict?: string | null;
  merged?: boolean | null;
  title?: string | null;
}

/** One lane's record in order, as a person would tell it: what it is, what was done,
 *  what was decided and by whom (`GET /run/:id/story`). Each entry is one plain
 *  sentence with the moment it happened and, when there is one, the thing to open. */
export interface LaneStoryEntry {
  at: number;
  /** ticket | plan | branch | commit | pr | council | jira | park | answer | warden | merge | end */
  kind: string;
  text: string;
  url?: string | null;
}

export interface LaneStory {
  id: string;
  title: string | null;
  kind: LaneKind;
  ticket: { key: string; url: string | null; summary: string | null } | null;
  brief: { path: string; excerpt: string } | null;
  entries: LaneStoryEntry[];
}

/** What a bulk merge would do, listed before it does it (`GET /merge-ready`): every lane
 *  whose PR is ready by the queue's own rules, and every lane with a PR that is not,
 *  each with the reason in words. */
export interface MergeReadyReport {
  ready: Array<{ id: string; title: string | null; pr: LanePr; readiness?: LaneReadiness }>;
  notReady: Array<{ id: string; title: string | null; pr: LanePr; why: string; readiness?: LaneReadiness }>;
}

/**
 * 2026-09-07: the ticket sheet's audit record, the council's own last verdict on this
 * lane's PR, off the attestation the gate wrote to disk. `stale` is true the moment the
 * PR's head has moved past the sha this attestation actually reviewed, so a person never
 * reads a verdict as current when the diff underneath it has already changed.
 */
export interface LaneAudit {
  verdict: string;
  reviewed: number;
  total: number;
  at: number;
  head: string;
  findings: number;
  /** One short line per deciding finding (`<member>: <claim>`) -- what "View council"
   *  promises to show, so the summary's audit line names what actually decided the
   *  verdict rather than just how many findings there were. Empty when there are none. */
  findingsText: string[];
  stale: boolean;
  staleWhy: string | null;
}

/**
 * 2026-09-07: whether a lane's PR is proven ready for a person's own Merge click:
 * checks, the council's verdict, the queue's merge allow-list, and drift (the PR head
 * moving past its own audit, the base branch gaining commits since the PR's merge-base).
 * `why` is null only when every one of those actually cleared; `behindBase`/`headMoved`
 * carry on regardless, since a ready lane can still be worth flagging as close to drifting.
 */
export interface LaneReadiness {
  ok: boolean;
  why: string | null;
  checks: 'success' | 'failure' | 'pending' | null;
  behindBase: number | null;
  headMoved: boolean;
}

/**
 * 2026-09-07: the ticket sheet's own summary block, read before anything else on the
 * sheet: what was done, the lane's own `plain` status, whether it was audited, and
 * whether it is proven ready to merge. `what` is never padded: a lane with only one real
 * fact on record (a PR title, a single commit) gets one sentence, not several invented
 * ones to hit a target count.
 */
export interface LaneSummary {
  what: string[];
  status: string;
  /** The one thing to do next, in the operator's own terms: "Answer the question
   *  below.", "Merge it.", "Nothing needed; let it work.", "Read the reason, then Resume
   *  or Kill." Never empty, never a state word on its own. */
  next: string;
  audit: LaneAudit | null;
  readiness: LaneReadiness | null;
}

/** `POST /run/:id/reaudit`'s own response: the council round is fired in the
 *  background (it can run for minutes), and this only confirms it started. The result
 *  lands as a new attestation and a `council.*` journal sequence, the same as the
 *  queue's own round, readable off the next `GET /run/:id/summary`. */
export interface ReauditResponse {
  started: boolean;
  reason?: string;
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
  /** What a person needs to recognise this lane without decoding its run id
   *  (2026-09-07, after the board was read as thirty-one identical machine names).
   *  `title` is the ticket's own summary, the brief's first heading, or a label for a
   *  probe or a self item; `kind` is where the lane came from; `sourceUrl` is the ticket
   *  or brief it came from; `plain` is one sentence on where it stands and what happens
   *  next; `mergeable` says whether Merge would act and, when not, why; `attempts` is
   *  how many runs share this ticket, so repeated tries fold into one card. */
  title: string | null;
  kind: LaneKind;
  sourceUrl: string | null;
  plain: string;
  mergeable: { ok: true } | { ok: false; why: string } | null;
  attempts: number;
  /** Set once an operator retired the lane off the default board (`POST /run/:id/retire`
   *  or the bulk retire); it stays readable under the Archived filter. */
  retiredAt: number | null;
}

/** Where a lane came from: a queued Jira ticket, a typed hotfix, a pasted brief, a
 *  self-analysis finding, the unattended chain, a live probe of the runner itself, or
 *  a run started by hand at the CLI. */
export type LaneKind = 'ticket' | 'hotfix' | 'brief' | 'self' | 'chain' | 'probe' | 'manual';

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

/** `activity`: a plain-mode digest of a run's own tool calls ("Worked 16:57 to 17:04:
 *  140 commands, 45 file reads, 11 edits"), drawn as a quiet line rather than a chip.
 *  Only `/run/:id/thread` without `?verbose=1` produces one. */
export type MessageType =
  | 'event'
  | 'activity'
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

// ---------------------------------------------------------------------------------------
// Intake queue: the board's own way to hand Forge work, rather than only supervise it.
// ---------------------------------------------------------------------------------------

/** Where a queue item came from: a Jira ticket key, a pasted brief, a JQL query naming a
 *  sprint or epic, the backlog with an operator's own filter text, or a typed hotfix
 *  (A.6) -- no Jira ticket at all, branching off the repo's hotfix base rather than its
 *  ordinary one. A hotfix ships to dev on Merge and to production on a separate Promote
 *  click (A.7); it is never merged straight to production. */
export type QueueSource = 'ticket' | 'brief' | 'query' | 'backlog' | 'hotfix';

/** `queued` waits for a slot; `planning` and `running` are the two the worker keeps
 *  in flight; `parked` is a question, a refusal, or a gate that did not pass -- always a
 *  person's call, never a retry loop; `review` has a draft PR waiting; `failed` is a hard
 *  error (planning, provisioning, or launch itself threw); `done` is set only by an
 *  operator, never by the worker -- every item stops at a draft PR. */
export type QueueItemState = 'queued' | 'planning' | 'running' | 'parked' | 'review' | 'failed' | 'done';

export interface QueueItem {
  id: string;
  source: QueueSource;
  /** The raw input the item was added with: the ticket key, the pasted brief text, the
   *  JQL the query/backlog source resolved against. */
  input: string;
  ticket: string | null;
  /** The routed repository (`owner/name`), or `'unknown'` when nothing routed it. */
  repo: string | null;
  briefPath: string | null;
  /** The provisioned worktree's own branch, path and base -- set once the launch hop
   *  runs, null before. Carried on the item (not re-derived) so a restart's gate hop
   *  can find the item's PR by head and pass the council its `cwd`/`baseRef` without
   *  re-provisioning anything. */
  branch: string | null;
  worktreePath: string | null;
  base: string | null;
  state: QueueItemState;
  /** Why the item is `parked` or `failed`, when the worker knows. */
  reason: string | null;
  runKey: string | null;
  pr: LanePr | null;
  /** Every journal row this item's own transitions wrote, in order -- the same audit
   *  trail `GET /journal` renders, so a queue item's history is never a second ledger. */
  journalIds: string[];
  createdAt: number;
  updatedAt: number;
  /** A.1: how many times this item has been relaunched on a FIX FIRST round -- 0 or
   *  absent means the fix round hasn't been used yet, and it's capped at one. */
  fixRoundsUsed?: number;
  /** A.3: when the Jira write-back at review ran for this item -- absent means it
   *  hasn't fired yet. Set once, alongside the transition into `review`. */
  handoffAt?: number;
  /** A.8/A.9: the PR's own changed-file paths, fetched once the item has a PR and
   *  before the council reads it -- shared by A.8's real figures at `review` and A.9's
   *  overlap check against every other item running or in review on the same repo. */
  changedFiles?: string[] | null;
  /** D2.3: the council's own findings against this item's draft PR, one line each --
   *  absent or empty means the council hasn't posted a note (or none is due) yet. */
  councilNotes?: string[] | null;
  /** H1.2 fix: the attestation file the gate wrote for this item's own review round,
   *  carried on the item the moment it lands so `plain` can read the council's real
   *  verdict and coverage straight off disk -- no PR head sha needed to find it, since
   *  the gate already resolved that path once. Absent for an item that never reached a
   *  council round (parked earlier, still queued, and so on). */
  attestationPath?: string | null;
  /** A.7: when a hotfix's own Promote actually ran, and the version string the operator
   *  typed for it -- absent for anything that has not been promoted (which is every
   *  non-hotfix item, and a hotfix still sitting on `done`). Once set, the card shows
   *  "promoted <version>" instead of the Promote button. */
  promotedAt?: number | null;
  promotedVersion?: string | null;
}

export interface QueueResponse {
  items: QueueItem[];
  paused: boolean;
  maxInFlight: number;
  /** D2.3: set alongside `paused` when the worker itself paused the queue (three
   *  consecutive tick errors), rather than an operator's own Pause click -- absent or
   *  null means whatever `paused` says was an operator's own doing. */
  pauseReason?: string | null;
}

export interface QueueAddRequest {
  source: QueueSource;
  /** A ticket key, pasted brief text, a JQL query, or a backlog filter string,
   *  depending on `source`. */
  input: string;
}

export interface QueueAddResponse {
  ok: boolean;
  /** Every item the add created -- one for `ticket`/`brief`, one per matching ticket for
   *  `query`/`backlog`. Empty alongside `ok: false`. */
  items: QueueItem[];
  /** Set on refusal -- most commonly a `query`/`backlog` add with no Jira credentials
   *  configured, which says so exactly rather than failing silently. */
  error?: string;
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

/**
 * Plain by default: a run's own thread reads as what it did, what it said and what was
 * asked of it, with tool calls folded into `activity` digests and every machine id
 * turned into words. `?verbose=1` answers the raw rows instead, one message per journal
 * row exactly as `textFor` names it. The same switch applies to `GET /thread` and
 * `GET /run/:id/story`.
 */
export interface RunThreadResponse {
  messages: Message[];
  /** True when the caller asked for `?verbose=1` and got the raw rows. */
  verbose?: boolean;
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
 * D2.4: the one field of the real server's own (much larger) `/state` the web console
 * needs -- whether the queue subsystem is running at all, distinct from a queue that is
 * running but merely paused (the desktop status window already reads this same flag off
 * the real server; see `desktop/electron/queue-state.ts`). The console never reads the
 * rest of `/state`'s per-run truth, so this type carries only the one field it does.
 */
export interface ConsoleStateSummary {
  queue_on: boolean;
  /** The revision the server is running, so an open board can notice the server moved
   *  on underneath it (a self cutover, a restart onto a new head) and reload itself
   *  instead of rendering new data with stale components (2026-09-07: a window open
   *  since the morning showed the old tiles over the new sentences). */
  build?: string;
}

/**
 * The routes. Reads carry the token like every other read except `/state`; writes carry
 * it and are refused without it. Every write journals a row and returns its jid.
 *
 * Reads
 *   GET  /state                          ConsoleStateSummary (no token required)
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
 *   GET  /run/:id/story                  LaneStory
 *   GET  /run/:id/summary                LaneSummary
 *   GET  /queue                          QueueResponse
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
 *   POST /run/:id/recheck   {}           LaneSummary    fresh PR/audit/drift facts, cache bypassed
 *   POST /run/:id/reaudit   {}           ReauditResponse   runs the council again on the current head
 *   POST /run/:id/cap       {tokenCap}   ActionResult   undoable
 *   POST /caps              {dailyTokens?, runTokens?}  Caps | 422 {error, hardTokens}   undoable
 *   POST /command           {text}       CommandResponse
 *   POST /integrations/:id/check         IntegrationsResponse
 *   POST /integrations/:id/reconnect     ReconnectResponse
 *   POST /proposals/:id/apply            ActionResult   undoable
 *   POST /proposals/:id/dismiss          ActionResult   undoable (restore)
 *   POST /proposals/:id/restore          ActionResult
 *   POST /journal/:jid/undo              ActionResult
 *   POST /queue              {source, input}  QueueAddResponse   adds one item (query/backlog can add several)
 *   POST /queue/:id/remove   {}           ActionResult
 *   POST /queue/:id/retry    {}           ActionResult   sends a parked/failed item back to queued
 *   POST /queue/pause        {}           ActionResult   stops the worker from starting anything new
 *   POST /queue/resume       {}           ActionResult
 *   POST /run/:id/retire     {}           ActionResult   undoable (unretire); refused on an unfinished lane
 *   POST /run/:id/unretire   {}           ActionResult
 *   POST /retire-finished    {}           ActionResult & { retired: string[] }
 *
 * A write whose mechanism does not exist yet answers 501 `{error, reason}`; the rail
 * renders that as a refusal card and never pretends the action ran.
 */
export const CONSOLE_ROUTES = [
  '/lanes', '/thread', '/journal', '/integrations', '/caps', '/proposals', '/command', '/queue',
  // 2026-09-07: the human-readable layer. `/merge-ready` lists what a bulk merge would
  // do; `/retire-finished` retires every finished, killed or probe lane with no open PR.
  '/merge-ready', '/retire-finished',
] as const;
