/**
 * The board's write surface: the deterministic command grammar behind the Conductor
 * composer, and `ConsoleWrites`, the one class `server.ts` delegates every console write
 * (and `GET /integrations`, which this stream owns despite being a read) to.
 *
 * The grammar is regex, not a model: the HANDOFF spec asks for "an LLM with the same
 * intents" eventually, but nothing in this repository wires a chat model into console
 * writes today, and a 501 for "not wired yet" beats a prompt injection surface with no
 * review. Reversible intents (pause, resume, a cap, an answer) run immediately and
 * return a receipt card; irreversible ones (kill, merge) return a confirm card whose
 * `Confirm` button is a second command, `confirm <token>`, that this module remembers
 * for the lifetime of the process. A plan card (`merge ready lanes`) is the same idea
 * one level up: `Run plan` sends `run <token>`.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';

import type { Actuator } from '../contracts.js';
import { foldChainState } from '../chain.js';
import type { Inbox } from '../inbox.js';
import { deliverAnswer } from '../runinbox.js';
import { appendOnce, replay } from '../journal.js';
import type { StuckSignal } from '../liveness.js';
import type { Registry } from '../registry.js';
import type { RunRequest } from '../exec.js';
import type { Lanes } from '../supervisor.js';
import type { QueueStore } from '../intake/queueStore.js';
import { governorBudget } from '../policy.js';
import { forgeHome } from '../paths.js';
import { retireLane } from './retire.js';
import { consoleDir, recordAction, ActionsLedger, actionsLedgerPath } from './actions-ledger.js';
import {
  compactRun, killRun, mergeRun, pauseRun, reauditRun, reopenRun, restoreRunCap,
  resumeRun, setRunCap, verifyRun, type RunActionsDeps,
} from './run-actions.js';
import { capsOverridesPath, effectiveHardTokens, readCapsOverrides } from './caps-read.js';
import { restoreCaps, writeCaps, type CapsWriteDeps } from './caps-write.js';
import { IntegrationsRegistry, type IntegrationsDeps } from './integrations.js';
import { labelFor as laneLabelFor, laneStateNowFor, meaningfulEvents, tokensToday } from './lanes.js';
import { signalPhrase } from './journal-narrative.js';
import { plainEventText } from './thread.js';
import {
  applyRule, dismissRule, restoreRule, rulesPath, setRuleStatus, startEnforcementTick,
  type RulesDeps,
} from './rules.js';
import type { ActionResult, LanesResponse, Message, PlanItem } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import { stripMachineIds } from '../../shared/humanize.js';

const REASON_LIMIT = 140;

/** Item 8: what a person calls a lane, off the same lanes view every reply reads
 *  from -- delegates to `lanes.ts`'s own `labelFor`, the one implementation the whole
 *  server now shares, rather than a second copy that can drift from it. */
function labelFor(view: LanesResponse | undefined, id: string): string {
  return laneLabelFor(id, (candidateId) => {
    const lane = view?.lanes.find((l) => l.id === candidateId);
    return lane ? { ticket: lane.ticket, title: lane.title } : null;
  });
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Up to five lanes worth an operator's attention right now: parked, blocked, or
 *  running away on cost, labeled with whichever of those is true (a lane is never
 *  parked/blocked and runaway at once -- runaway only applies while running or handed
 *  off). `status` names them so the reply is something to act on, not just a count. */
function attentionLines(view: LanesResponse): string[] {
  return view.lanes
    .filter((lane) => lane.state === 'parked' || lane.state === 'blocked' || lane.runaway)
    .slice(0, 5)
    .map((lane) => {
      const state = lane.runaway ? 'runaway' : lane.state;
      const rawReason = lane.reason ?? (lane.runaway ? 'over its token cap' : 'no reason recorded');
      const reason = truncate(stripMachineIds(rawReason, { labelFor: (id) => labelFor(view, id) }), REASON_LIMIT);
      return `- ${labelFor(view, lane.id)} (${state}): ${reason}`;
    });
}

function statusText(view: LanesResponse): string {
  const counts = new Map<string, number>();
  for (const lane of view.lanes) counts.set(lane.state, (counts.get(lane.state) ?? 0) + 1);
  const byState = [...counts.entries()].map(([state, n]) => `${n} ${state}`).join(', ') || 'none';
  const total = view.lanes.length;
  const lines = [
    `${total} lane${total === 1 ? '' : 's'}: ${byState}.`,
    `Spent ${fmtTokens(view.tokensToday)} tokens today, burning ${fmtTokens(view.tokensPerMin)} tokens a minute.`,
  ];
  const attention = attentionLines(view);
  if (attention.length) lines.push('Needs you:', ...attention);
  return lines.join('\n');
}

function threadPath(): string {
  return join(consoleDir(), 'thread.jsonl');
}

/** Exported so `blockers-restart.ts` writes its own rail receipts to the same
 *  `thread.jsonl` this class's own cards land in, rather than a second file. */
export function appendThread(message: Message): void {
  const path = threadPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(message)}\n`, 'utf8');
}

/** Exported for `server.ts`'s own Blockers wiring: a plain-text rail receipt, the same
 *  shape every other console write's own confirmation card uses. */
export function plainReceiptCard(text: string): Message {
  return { k: randomUUID(), type: 'receipt', text, ts: Date.now(), source: 'blockers', resolved: 'ran' };
}

/** The one sentence a failed run action has to say: `message` (an `ActionResult`),
 *  else `reason` (a 501 "not wired"), else `error` (a state refusal), else the fallback. */
export function actionFailureText(body: unknown, fallback: string): string {
  const row = (body ?? {}) as { message?: string; reason?: string; error?: string };
  return row.message ?? row.reason ?? row.error ?? fallback;
}

function receiptCard(source: string, result: ActionResult): Message {
  return {
    k: randomUUID(), type: 'receipt', text: result.message, ts: Date.now(), source,
    jid: result.jid ?? undefined, undoable: result.undoable, resolved: 'ran',
  };
}

function refusalCard(source: string, text: string): Message {
  return { k: randomUUID(), type: 'refusal', text, ts: Date.now(), source };
}

function confirmCard(source: string, blast: string, token: string): Message {
  return {
    k: randomUUID(), type: 'confirm', text: 'confirm?', ts: Date.now(), source, blast,
    btns: [
      { label: 'Confirm', cmd: `confirm ${token}`, cls: 'destroy' },
      { label: 'Not now', cmd: `dismiss ${token}` },
    ],
  };
}

function planCard(source: string, items: PlanItem[], token: string): Message {
  return {
    k: randomUUID(), type: 'plan', text: 'plan', ts: Date.now(), source, items,
    btns: [
      { label: 'Run plan', cmd: `run ${token}`, cls: 'go' },
      { label: 'Not now', cmd: `dismiss ${token}` },
    ],
  };
}

function replyCard(source: string, text: string): Message {
  return { k: randomUUID(), type: 'reply', text, ts: Date.now(), source };
}

// ---------------------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------------------

export type Intent =
  | { kind: 'pause'; repo?: string }
  | { kind: 'resume'; lane?: string }
  | { kind: 'kill'; lane: string }
  | { kind: 'retire'; lane: string }
  | { kind: 'reopen'; lane: string }
  | { kind: 'verify'; lane: string }
  | { kind: 'merge-ready' }
  | { kind: 'set-daily-cap'; amount: number }
  | { kind: 'set-run-cap'; lane: string; amount: number }
  | { kind: 'why-stuck'; lane: string }
  | { kind: 'what-stuck' }
  | { kind: 'spend-today' }
  | { kind: 'status' }
  | { kind: 'answer'; askKey: string | null; text: string }
  | { kind: 'confirm'; token: string }
  | { kind: 'run-plan'; token: string }
  | { kind: 'dismiss'; token: string }
  | { kind: 'cancel' }
  | { kind: 'unknown'; text: string };

/** A token amount typed into the composer -- a plain number, or one with a `k`/`m`
 *  suffix (`500k`, `2m`) the way an operator would actually type a cap rather than
 *  spelling out every zero. Never a dollar sign: the grammar this replaces used to
 *  accept an optional leading `$`, and this fleet has nothing left to price in it. */
/** Exported so the console stub (`stub-server.ts`) parses a typed token amount
 *  exactly the same way this grammar does, rather than a second regex drifting from
 *  it -- sweep #20 found the stub reading "50m tokens" as a bare 50 because its own
 *  copy captured only the leading digits and dropped the k/m suffix on the floor. */
export function tokenAmount(digits: string, suffix: string | undefined): number {
  const base = Number(digits);
  if (suffix?.toLowerCase() === 'k') return Math.round(base * 1_000);
  if (suffix?.toLowerCase() === 'm') return Math.round(base * 1_000_000);
  return base;
}

export function parseIntent(raw: string): Intent {
  const text = raw.trim();
  let match: RegExpMatchArray | null;

  if (/^cancel$/i.test(text)) return { kind: 'cancel' };
  if ((match = text.match(/^confirm\s+(\S+)$/i))) return { kind: 'confirm', token: match[1]! };
  if ((match = text.match(/^run\s+(\S+)$/i))) return { kind: 'run-plan', token: match[1]! };
  if ((match = text.match(/^dismiss\s+(\S+)$/i))) return { kind: 'dismiss', token: match[1]! };
  if (/^pause\b/i.test(text)) {
    const repoMatch = text.match(/on\s+(\S+)/i);
    return { kind: 'pause', ...(repoMatch ? { repo: repoMatch[1] } : {}) };
  }
  if ((match = text.match(/^resume\s+(\S+)$/i))) return { kind: 'resume', lane: match[1]! };
  if (/^resume$/i.test(text)) return { kind: 'resume' };
  if ((match = text.match(/^kill\s+(\S+)$/i))) return { kind: 'kill', lane: match[1]! };
  if ((match = text.match(/^(?:remove|archive|retire)\s+(\S+)$/i))) return { kind: 'retire', lane: match[1]! };
  if ((match = text.match(/^reopen\s+(\S+)$/i))) return { kind: 'reopen', lane: match[1]! };
  if ((match = text.match(/^verify\s+(\S+)$/i))) return { kind: 'verify', lane: match[1]! };
  if (/^merge\s+ready\s+lanes?$/i.test(text)) return { kind: 'merge-ready' };
  if ((match = text.match(/^(?:raise|set)\s+daily\s+cap\s+to\s+(\d+(?:\.\d+)?)([km])?$/i))) {
    return { kind: 'set-daily-cap', amount: tokenAmount(match[1]!, match[2]) };
  }
  if ((match = text.match(/^cap\s+(\S+)\s+at\s+(\d+(?:\.\d+)?)([km])?$/i))) {
    return { kind: 'set-run-cap', lane: match[1]!, amount: tokenAmount(match[2]!, match[3]) };
  }
  if ((match = text.match(/^why\s+is\s+(?:lane\s+)?(\S+)\s+stuck\??$/i))) {
    return { kind: 'why-stuck', lane: match[1]! };
  }
  if (/^what'?s\s+stuck\??$/i.test(text)) return { kind: 'what-stuck' };
  if (/^spend\s+today$/i.test(text)) return { kind: 'spend-today' };
  if (/^status$/i.test(text)) return { kind: 'status' };
  // `answer <askKey> <text>` (deliverable 3): the first token is an ask key -- an id at
  // least 8 hex characters long -- and only the text after it is the answer. Matching
  // it here, ahead of the plain free-text form below, is what stops the whole tail
  // ("f92af4249f6a27ae Restart the forge MCP connection") from being delivered to the
  // run as if the operator had typed the key as part of their answer.
  if ((match = text.match(/^answer\s+([0-9a-f]{8,})\s+(.+)$/i))) {
    return { kind: 'answer', askKey: match[1]!, text: match[2]! };
  }
  if ((match = text.match(/^answer\s+(.+)$/i))) return { kind: 'answer', askKey: null, text: match[1]! };
  return { kind: 'unknown', text };
}

// ---------------------------------------------------------------------------------------
// ConsoleWrites: the aggregator server.ts's route() delegates to.
// ---------------------------------------------------------------------------------------

export interface ConsoleWritesDeps {
  journalPath: string;
  registry: Registry;
  lanes?: Lanes;
  inbox: Inbox;
  actuator: Actuator;
  authorized: (request: IncomingMessage, response: ServerResponse) => boolean;
  stuck?: () => StuckSignal[];
  /** What `status` answers from: the same `Lane[]` and spend the board renders.
   *  Defaults to `${n} run(s) registered` off the registry when unset (a specimen that
   *  only cares about the write side never has to build a whole lanes view). */
  lanesView?: () => LanesResponse;
  spawnFn?: RunRequest['spawnFn'];
  ledgerPath?: string;
  capsOverridesPath?: string;
  rulesConfigPath?: string;
  integrationsConfigPath?: string;
  modelPolicyPath?: string;
  /** 2026-09-07: overrides where `reauditRun` finds a queue-sourced lane's own
   *  repo/PR/base/worktree (`POST /run/:id/reaudit`). Defaults to `RunActionsDeps`'s own
   *  default (`defaultQueuePath()`, which follows `FORGE_HOME`) when unset. */
  queueStore?: QueueStore;
  /** What `remove | archive | retire <lane>` retires against: the archived-inclusive
   *  lanes view (`lanesResponse(true, true)`) the retire rule reads heart and PR off.
   *  Falls back to `lanesView` when unset. */
  lanesViewAll?: () => LanesResponse;
  /** Where `retired.jsonl` lives. Defaults to `forgeHome()`. A specimen only. */
  forgeHomeDir?: string;
}

function readBody<T>(request: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk; });
    request.on('end', () => {
      if (!body) { resolve(null); return; }
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        resolve(null);
      }
    });
  });
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

interface PendingConfirm {
  blast: string;
  run: () => Promise<Message[]>;
  /** Set by a route-registered pending once it has run: the HTTP outcome the route
   *  answers with when the confirm arrives as `{ confirm: token }` in a body. */
  outcome?: RouteOutcome;
}

/** What a route handler answers with: the status and the JSON body. */
export interface RouteOutcome {
  status: number;
  body: unknown;
}

/** The body an irreversible route answers with (status 202) until the operator
 *  confirms. `card` is the same confirm card the typed grammar produces, so the rail
 *  and an inline control render one shape. */
export interface ConfirmPendingBody {
  ok: false;
  pending: true;
  token: string;
  blast: string;
  card: Message;
}

/** The one card a route-registered pending produces when it runs: a receipt for a
 *  200 carrying an `ActionResult`, a refusal with the server's sentence otherwise. */
function outcomeCard(source: string, outcome: RouteOutcome): Message {
  const body = (outcome.body ?? {}) as Partial<ActionResult> & { error?: string; reason?: string };
  if (outcome.status === 200 && typeof body.message === 'string') {
    return receiptCard(source, { ok: body.ok ?? true, jid: body.jid ?? null, message: body.message, undoable: body.undoable ?? false });
  }
  if (outcome.status === 200) return receiptCard(source, { ok: true, jid: null, message: 'done', undoable: false });
  return refusalCard(source, actionFailureText(outcome.body, `answered ${outcome.status}`));
}

interface PendingPlan {
  items: PlanItem[];
  run: () => Promise<Message[]>;
}

export class ConsoleWrites {
  private readonly ledger: ActionsLedger;

  private readonly integrations: IntegrationsRegistry;

  private readonly pendingConfirms = new Map<string, PendingConfirm>();

  private readonly pendingPlans = new Map<string, PendingPlan>();

  private enforcement: { stop(): void } | undefined;

  constructor(private readonly deps: ConsoleWritesDeps) {
    this.ledger = new ActionsLedger(deps.ledgerPath ?? actionsLedgerPath());
    this.integrations = new IntegrationsRegistry({
      journalPath: deps.journalPath, ledger: this.ledger,
      ...(deps.integrationsConfigPath ? { configPath: deps.integrationsConfigPath } : {}),
      ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
      ...(deps.lanesView ? { lanesView: deps.lanesView } : {}),
    });
    // Not started here: `server.ts` starts it from `listen()` and stops it in `close()`,
    // the same lifecycle the heartbeat timer already has. Starting it the moment a
    // `ForgeServer` is merely constructed, listening or not, left a 10-second tick
    // ticking against a journal a test's own temp dir had already been removed out from
    // under.
  }

  /** The one `IntegrationsRegistry` instance this class owns, for `server.ts` to hand to
   *  `blockers-gather.ts`/`blockers-confirm.ts` rather than constructing a second registry
   *  over the same config file. */
  integrationsRegistry(): IntegrationsRegistry {
    return this.integrations;
  }

  /** Starts the 10-second rule-enforcement tick. Called once by `server.ts#listen()`;
   *  a second call is a no-op. */
  start(): void {
    if (this.enforcement) return;
    this.enforcement = startEnforcementTick({
      journalPath: this.deps.journalPath,
      ...(this.deps.rulesConfigPath ? { rulesPath: this.deps.rulesConfigPath } : {}),
      inbox: this.deps.inbox,
      runActions: this.runActionsDeps(),
    });
  }

  /** Lets a caller (server shutdown, or a test) stop the 10-second rule tick. A no-op
   *  when `start()` was never called. */
  stop(): void {
    this.enforcement?.stop();
    this.enforcement = undefined;
  }

  /** `~/.forge/console/caps.json` (or a specimen's override) -- the one file every caps
   *  read and write in this class goes through, policy file untouched. */
  private overridesPath(): string {
    return this.deps.capsOverridesPath ?? capsOverridesPath(forgeHome());
  }

  /** Public so `server.ts` can hand the same deps to `blockers-restart.ts`'s
   *  `resumeRun` wiring, rather than this class rebuilding its own copy. */
  runActionsDeps(): RunActionsDeps {
    return {
      ledger: this.ledger, registry: this.deps.registry, actuator: this.deps.actuator,
      journalPath: this.deps.journalPath,
      hardTokens: () => effectiveHardTokens(readCapsOverrides(this.overridesPath())),
      ...(this.deps.lanes ? { lanes: this.deps.lanes } : {}),
      ...(this.deps.spawnFn ? { spawnFn: this.deps.spawnFn } : {}),
      ...(this.deps.capsOverridesPath ? { capsOverridesPath: this.deps.capsOverridesPath } : {}),
      ...(this.deps.queueStore ? { queueStore: this.deps.queueStore } : {}),
    };
  }

  private capsWriteDeps(): CapsWriteDeps {
    return {
      journalPath: this.deps.journalPath, ledger: this.ledger,
      overridesPath: this.overridesPath(),
      tokensToday: () => this.spendToday(),
      governorConfigured: () => {
        const budget = governorBudget(this.deps.modelPolicyPath);
        return Number.isFinite(budget.dailyUsd) || Object.keys(budget.usdPerRun).length > 0;
      },
    };
  }

  private rulesDeps(): RulesDeps {
    return {
      journalPath: this.deps.journalPath, ledger: this.ledger,
      ...(this.deps.rulesConfigPath ? { path: this.deps.rulesConfigPath } : {}),
    };
  }

  private spendToday(): number {
    return tokensToday(replay(this.deps.journalPath).runs, Date.now());
  }

  /**
   * Deliverable 4: a lane addressed by a ticket key, a lane id, or a piece of its
   * title -- resolved to the newest lane whose ticket matches (case-insensitive), else
   * a lane whose id equals the token exactly, else a lane whose title contains the
   * token (case-insensitive), in that order. Without a `lanesView` wired at all there
   * is nothing here to resolve against, so the token passes through unchanged -- the
   * same behaviour every command already had before this deliverable.
   *
   * Returns the resolved lane id, or a refusal message naming exactly what it looked
   * for when `lanesView` is wired and nothing on the board matches.
   */
  private resolveLaneId(token: string): string | { refusal: string } {
    const view = this.deps.lanesView?.();
    if (!view) return token;
    const lowerToken = token.toLowerCase();

    let byTicket: (typeof view.lanes)[number] | undefined;
    for (const lane of view.lanes) {
      if ((lane.ticket ?? '').toLowerCase() !== lowerToken) continue;
      if (!byTicket || lane.startedAt > byTicket.startedAt) byTicket = lane;
    }
    if (byTicket) return byTicket.id;

    const byId = view.lanes.find((lane) => lane.id === token);
    if (byId) return byId.id;

    const byTitle = view.lanes.find((lane) => (lane.title ?? '').toLowerCase().includes(lowerToken));
    if (byTitle) return byTitle.id;

    return { refusal: `No lane matches "${token}".` };
  }

  private readyToMergeRuns(): string[] {
    const { events } = replay(this.deps.journalPath);
    const rows = foldChainState(events);
    const ready: string[] = [];
    for (const row of rows.values()) {
      if (!row.launched || row.merged || row.stopped) continue;
      if (row.gated && (row.gated.verdict === 'PASS' || row.gated.verdict === 'PASS WITH NOTES')) {
        ready.push(row.launched.runKey);
      }
    }
    return ready;
  }

  /** The undo dispatcher `POST /journal/:jid/undo` drives. Every kind here mirrors a
   *  `undo.kind` some write above sets on its ledger row. */
  private async runUndo(row: { kind: string; run: string | null; jid: string }, undo: { kind: string; payload: Record<string, unknown> }): Promise<{ status: number; body: ActionResult }> {
    switch (undo.kind) {
      case 'resume-run': {
        const run = String(undo.payload['run']);
        const outcome = await resumeRun(run, this.runActionsDeps());
        return { status: outcome.status, body: outcome.body as ActionResult };
      }
      case 'restore-run-cap': {
        const run = String(undo.payload['run']);
        const tokenCap = (undo.payload['tokenCap'] as number | null) ?? null;
        restoreRunCap(run, tokenCap, this.runActionsDeps());
        const { jid } = recordAction(this.deps.journalPath, this.ledger, {
          kind: 'run-cap-undo', run, text: `restored ${run}'s cap`, undo: null,
        });
        return { status: 200, body: { ok: true, jid, message: `restored ${run}'s cap`, undoable: false } };
      }
      case 'restore-caps': {
        restoreCaps({
          dailyTokens: (undo.payload['dailyTokens'] as number | null) ?? null,
          runTokens: (undo.payload['runTokens'] as number | null) ?? null,
        }, this.overridesPath());
        const { jid } = recordAction(this.deps.journalPath, this.ledger, {
          kind: 'caps-undo', text: 'restored the previous caps', undo: null,
        });
        return { status: 200, body: { ok: true, jid, message: 'restored the previous caps', undoable: false } };
      }
      case 'rule-status': {
        const id = String(undo.payload['id']);
        const status = undo.payload['status'] as 'open' | 'applied' | 'dismissed';
        setRuleStatus(id, status, this.rulesDeps());
        const { jid } = recordAction(this.deps.journalPath, this.ledger, {
          kind: 'rule-status-undo', text: `set ${id} back to ${status}`, undo: null,
        });
        return { status: 200, body: { ok: true, jid, message: `set ${id} back to ${status}`, undoable: false } };
      }
      default:
        return {
          status: 409,
          body: { ok: false, jid: null, message: `no undo for ${row.kind}`, undoable: false },
        };
    }
  }

  /** The retire implementation shared with `server.ts`'s route and the agent's tool. */
  private retireDeps() {
    return {
      forgeHomeDir: this.deps.forgeHomeDir ?? forgeHome(), journalPath: this.deps.journalPath,
      lanesAll: () => (this.deps.lanesViewAll ?? this.deps.lanesView)?.().lanes ?? [],
    };
  }

  /**
   * Registers a server-side confirm for an irreversible action and returns the token
   * and the card. The grammar's kill/retire and every irreversible Conductor-agent tool
   * (W2) go through this one map, so a typed or clicked `confirm <token>` finds the
   * pending action wherever it was proposed.
   */
  propose(source: string, blast: string, run: () => Promise<Message[]>): { token: string; card: Message } {
    const token = randomUUID();
    this.pendingConfirms.set(token, { blast, run });
    return { token, card: confirmCard(source, blast, token) };
  }

  /** Whether `confirm <token>` would still find something to run. */
  hasPending(token: string): boolean {
    return this.pendingConfirms.has(token);
  }

  /**
   * The confirm gate every irreversible route runs behind. Without a `confirm` token
   * in the body it registers the action in the same pending map the grammar's own
   * `kill <lane>` uses and answers 202 with the token and the card; with a token it
   * runs that pending action, writes its card to the rail's thread and answers with the
   * action's own outcome. A typed `confirm <token>` in the rail reaches the same
   * pending entry, so the two paths never disagree about what is waiting.
   */
  async confirmGate(
    body: Record<string, unknown> | null | undefined, source: string, blast: string,
    act: () => Promise<RouteOutcome>,
  ): Promise<RouteOutcome> {
    const token = body?.['confirm'];
    if (typeof token === 'string') {
      const pending = this.pendingConfirms.get(token);
      if (!pending) return { status: 409, body: { error: `nothing pending for ${token}` } };
      this.pendingConfirms.delete(token);
      const cards = await pending.run();
      for (const card of cards) appendThread(card);
      return pending.outcome ?? { status: 200, body: { ok: true, jid: null, message: cards[0]?.text ?? 'done', undoable: false } };
    }
    const pending: PendingConfirm = {
      blast,
      run: async () => {
        const outcome = await act();
        pending.outcome = outcome;
        return [outcomeCard(source, outcome)];
      },
    };
    const fresh = randomUUID();
    this.pendingConfirms.set(fresh, pending);
    const reply: ConfirmPendingBody = { ok: false, pending: true, token: fresh, blast, card: confirmCard(source, blast, fresh) };
    return { status: 202, body: reply };
  }

  private async executeIntent(intent: Intent, source: string): Promise<Message[]> {
    switch (intent.kind) {
      case 'cancel':
        return [replyCard(source, 'cancelled')];

      case 'confirm': {
        const pending = this.pendingConfirms.get(intent.token);
        if (!pending) return [refusalCard(source, `nothing pending for ${intent.token}`)];
        this.pendingConfirms.delete(intent.token);
        return pending.run();
      }

      case 'run-plan': {
        const pending = this.pendingPlans.get(intent.token);
        if (!pending) return [refusalCard(source, `nothing pending for ${intent.token}`)];
        this.pendingPlans.delete(intent.token);
        return pending.run();
      }

      // A card's own "Not now": declines a pending confirm or plan by its token
      // rather than the untargeted `cancel`, so one dismiss can never resolve a
      // different pending card than the one its button was on.
      case 'dismiss': {
        if (this.pendingConfirms.delete(intent.token) || this.pendingPlans.delete(intent.token)) {
          return [replyCard(source, 'dismissed')];
        }
        return [refusalCard(source, `nothing pending for ${intent.token}`)];
      }

      case 'pause': {
        const rows = this.deps.registry.all().filter((row) => (
          !intent.repo || row.cwd.includes(intent.repo) || row.goal.includes(intent.repo)
        ));
        const cards: Message[] = [];
        for (const row of rows) {
          const outcome = await pauseRun(row.goal, 'paused from the console', this.runActionsDeps());
          cards.push(outcome.status === 200
            ? receiptCard(source, outcome.body as ActionResult)
            : refusalCard(source, (outcome.body as { message?: string }).message ?? `could not pause ${row.goal}`));
        }
        if (!cards.length) cards.push(replyCard(source, 'nothing to pause'));
        return cards;
      }

      case 'resume': {
        if (intent.lane) {
          const resolved = this.resolveLaneId(intent.lane);
          if (typeof resolved !== 'string') return [refusalCard(source, resolved.refusal)];
          const outcome = await resumeRun(resolved, this.runActionsDeps());
          return [outcome.status === 200
            ? receiptCard(source, outcome.body as ActionResult)
            : refusalCard(source, (outcome.body as { message?: string }).message ?? `could not resume ${resolved}`)];
        }
        const rows = this.deps.registry.all().filter((row) => this.deps.lanes?.get(row.goal)?.needs_aaron);
        const cards: Message[] = [];
        for (const row of rows) {
          const outcome = await resumeRun(row.goal, this.runActionsDeps());
          cards.push(receiptCard(source, outcome.body as ActionResult));
        }
        if (!cards.length) cards.push(replyCard(source, 'nothing paused to resume'));
        return cards;
      }

      case 'kill': {
        const resolved = this.resolveLaneId(intent.lane);
        if (typeof resolved !== 'string') return [refusalCard(source, resolved.refusal)];
        const laneId = resolved;
        const view = this.deps.lanesView?.();
        const label = labelFor(view, laneId);
        const blast = `${label} stops now; its worktree and process are gone.`;
        const { card } = this.propose(source, blast, async () => {
          const outcome = await killRun(laneId, 'killed from the console', this.runActionsDeps());
          return [outcome.status === 200
            ? receiptCard(source, outcome.body as ActionResult)
            : refusalCard(source, (outcome.body as { message?: string }).message ?? `could not kill ${label}`)];
        });
        return [card];
      }

      case 'retire': {
        const resolved = this.resolveLaneId(intent.lane);
        if (typeof resolved !== 'string') return [refusalCard(source, resolved.refusal)];
        const laneId = resolved;
        const label = labelFor(this.deps.lanesView?.(), laneId);
        const blast = `${label} leaves the board; it stays under Archived and can be brought back.`;
        const { card } = this.propose(source, blast, async () => {
          const outcome = retireLane(laneId, true, this.retireDeps());
          return [outcome.status === 200
            ? receiptCard(source, outcome.body)
            : refusalCard(source, outcome.body.error)];
        });
        return [card];
      }

      case 'reopen': {
        const resolved = this.resolveLaneId(intent.lane);
        if (typeof resolved !== 'string') return [refusalCard(source, resolved.refusal)];
        const outcome = await reopenRun(resolved, this.runActionsDeps());
        return [outcome.status === 200
          ? receiptCard(source, outcome.body as ActionResult)
          : refusalCard(source, actionFailureText(outcome.body, `could not reopen ${resolved}`))];
      }

      case 'verify': {
        const resolved = this.resolveLaneId(intent.lane);
        if (typeof resolved !== 'string') return [refusalCard(source, resolved.refusal)];
        const outcome = await verifyRun(resolved, this.runActionsDeps());
        return [outcome.status === 200
          ? receiptCard(source, outcome.body as ActionResult)
          : refusalCard(source, actionFailureText(outcome.body, `could not verify ${resolved}`))];
      }

      case 'merge-ready': {
        const ready = this.readyToMergeRuns();
        if (!ready.length) return [replyCard(source, 'Nothing is ready to merge.')];
        const view = this.deps.lanesView?.();
        const token = randomUUID();
        const items: PlanItem[] = ready.map((run) => {
          const lane = view?.lanes.find((candidate) => candidate.id === run);
          const label = labelFor(view, run);
          return { text: lane?.pr?.no ? `Merge PR #${lane.pr.no} (${label})` : `Merge ${label}`, irreversible: true };
        });
        this.pendingPlans.set(token, {
          items,
          run: async () => {
            const cards: Message[] = [];
            for (const run of ready) {
              const outcome = await mergeRun(run, this.runActionsDeps());
              cards.push(outcome.status === 200
                ? receiptCard(source, outcome.body as ActionResult)
                : refusalCard(source, (outcome.body as { error?: string; message?: string }).message
                  ?? (outcome.body as { error?: string }).error ?? `could not merge ${labelFor(view, run)}`));
            }
            return cards;
          },
        });
        return [planCard(source, items, token)];
      }

      case 'set-daily-cap': {
        const outcome = await writeCaps({ dailyTokens: intent.amount }, this.capsWriteDeps());
        return [outcome.status === 200
          ? replyCard(source, `daily cap set to ${fmtTokens(intent.amount)} tokens`)
          : refusalCard(source, `${(outcome.body as { error: string }).error} (FD-7)`)];
      }

      case 'set-run-cap': {
        const resolved = this.resolveLaneId(intent.lane);
        if (typeof resolved !== 'string') return [refusalCard(source, resolved.refusal)];
        const outcome = await setRunCap(resolved, intent.amount, this.runActionsDeps());
        return [outcome.status === 200
          ? receiptCard(source, outcome.body as ActionResult)
          : refusalCard(source, `${(outcome.body as { error: string }).error} (FD-7)`)];
      }

      case 'why-stuck': {
        const resolved = this.resolveLaneId(intent.lane);
        if (typeof resolved !== 'string') return [refusalCard(source, resolved.refusal)];
        const laneId = resolved;
        const view = this.deps.lanesView?.();
        const label = labelFor(view, laneId);
        const signals = (this.deps.stuck?.() ?? []).filter((signal) => signal.key === laneId);
        const fleet = replay(this.deps.journalPath);
        const runEvents = fleet.events.filter((event) => event.run === laneId);
        if (!signals.length && !runEvents.length) return [replyCard(source, `Nothing is known about ${label}.`)];
        const chain = foldChainState(fleet.events);
        const { state, reason } = laneStateNowFor(laneId, { fleet, chain, laneRecord: this.deps.lanes?.get(laneId) });
        const reasonText = reason ? stripMachineIds(reason, { labelFor: (id) => labelFor(view, id) }) : 'no reason recorded';
        const lines = [`${label} is ${state}: ${reasonText}`];
        for (const signal of signals) lines.push(signalPhrase(signal.signal));
        const lastThree = meaningfulEvents(runEvents).slice(-3).map((event) => plainEventText(event));
        if (lastThree.length) {
          lines.push('Last it did:', ...lastThree);
        }
        return [replyCard(source, lines.join('\n'))];
      }

      case 'what-stuck': {
        const signals = this.deps.stuck?.() ?? [];
        if (!signals.length) return [replyCard(source, 'Nothing is stuck.')];
        const view = this.deps.lanesView?.();
        const lines = signals.map((signal) => `- ${labelFor(view, signal.key)}: ${signalPhrase(signal.signal)}`);
        return [replyCard(source, lines.join('\n'))];
      }

      case 'spend-today':
        return [replyCard(source, `spent ${fmtTokens(this.spendToday())} tokens today`)];

      case 'status': {
        const view = this.deps.lanesView?.();
        if (!view) return [replyCard(source, `${this.deps.registry.all().length} run(s) registered`)];
        return [replyCard(source, statusText(view))];
      }

      case 'answer': {
        const open = this.deps.inbox.open();
        const match = (intent.askKey ? open.find((ask) => ask.key === intent.askKey) : undefined)
          ?? open.find((ask) => ask.question.toLowerCase().includes(intent.text.toLowerCase()))
          ?? (!intent.askKey && open.length === 1 ? open[0] : undefined);
        if (!match) return [refusalCard(source, `no open question matches "${intent.askKey ?? intent.text}"`)];
        const answered = this.deps.inbox.answer(match.key, intent.text);
        if (!answered) return [refusalCard(source, `could not answer ${match.key}`)];
        await deliverAnswer(answered, match.key, intent.text);
        const { jid } = recordAction(this.deps.journalPath, this.ledger, {
          kind: 'answer', text: `answered ${match.key}: ${intent.text}`, undo: null, extra: { askKey: match.key },
        });
        const questionHead = match.question.length > 70 ? `${match.question.slice(0, 70)}…` : match.question;
        return [receiptCard(source, {
          ok: true, jid, message: `Answered "${questionHead}": ${intent.text}`, undoable: false,
        })];
      }

      case 'unknown':
      default:
        return [replyCard(source, 'I did not understand that. Try one of: pause, resume, kill <ticket>, remove <ticket>, reopen <ticket>, '
          + "verify <ticket>, merge ready lanes, raise daily cap to <n>, cap <ticket> at <n>, why is <ticket> stuck, what's stuck, spend today, status, answer <text>.")];
    }
  }

  async command(text: string): Promise<Message[]> {
    const operatorCard: Message = { k: randomUUID(), type: 'operator', text, ts: Date.now(), source: 'operator' };
    appendThread(operatorCard);
    const cards = await this.executeIntent(parseIntent(text), 'conductor');
    for (const card of cards) appendThread(card);
    return [operatorCard, ...cards];
  }

  /**
   * The single entry point `server.ts#route()` calls. Returns `true` when this module
   * owns the path (whether or not the request itself was well-formed), `false` when it
   * does not, so the caller's own 404 stays the last word for anything unclaimed.
   */
  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const method = request.method ?? 'GET';

    if (path === '/integrations' && method === 'GET') {
      if (!this.deps.authorized(request, response)) return true;
      respond(response, 200, await this.integrations.list(false));
      return true;
    }

    let match: RegExpMatchArray | null;

    if ((match = path.match(/^\/integrations\/([^/]+)\/check$/)) && method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      respond(response, 200, await this.integrations.check(decodeURIComponent(match[1]!)));
      return true;
    }
    if ((match = path.match(/^\/integrations\/([^/]+)\/reconnect$/)) && method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      respond(response, 200, await this.integrations.reconnect(decodeURIComponent(match[1]!)));
      return true;
    }

    if ((match = path.match(/^\/run\/([^/]+)\/(kill|pause|resume|merge|reopen|compact|verify|cap|reaudit)$/)) && method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      const run = decodeURIComponent(match[1]!);
      const action = match[2]!;
      const body = await readBody<Record<string, unknown>>(request);
      const deps = this.runActionsDeps();
      let outcome: { status: number; body: unknown };
      const label = labelFor(this.deps.lanesViewAll?.() ?? this.deps.lanesView?.(), run);
      switch (action) {
        case 'kill':
          outcome = await this.confirmGate(body, 'console', `kills ${label}: discards the working diff and stops the sandbox.`,
            () => killRun(run, String(body?.['reason'] ?? 'killed from the console'), deps));
          break;
        case 'pause':
          outcome = await pauseRun(run, String(body?.['reason'] ?? 'paused from the console'), deps);
          break;
        case 'resume':
          outcome = await resumeRun(run, deps);
          break;
        case 'merge':
          outcome = await this.confirmGate(body, 'console', `merges ${label}: merges the PR and closes the ticket.`,
            () => mergeRun(run, deps));
          break;
        case 'reopen':
          outcome = await reopenRun(run, deps);
          break;
        case 'compact':
          outcome = await compactRun(run, deps);
          break;
        case 'verify':
          outcome = await verifyRun(run, deps);
          break;
        case 'cap': {
          const tokenCap = Number(body?.['tokenCap']);
          outcome = await setRunCap(run, tokenCap, deps);
          break;
        }
        case 'reaudit':
          outcome = await reauditRun(run, deps);
          break;
        default:
          outcome = { status: 404, body: { error: 'unknown action' } };
      }
      respond(response, outcome.status, outcome.body);
      return true;
    }

    if (path === '/caps' && method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      const body = await readBody<{ dailyTokens?: number; runTokens?: number; confirm?: string }>(request);
      const wanted = [
        body?.dailyTokens !== undefined ? `daily ${fmtTokens(body.dailyTokens)}` : null,
        body?.runTokens !== undefined ? `per run ${fmtTokens(body.runTokens)}` : null,
      ].filter(Boolean).join(', ') || 'no change';
      const outcome = await this.confirmGate(body as Record<string, unknown> | null, 'console',
        `sets the token caps to ${wanted}: every running lane is governed by the new numbers at once.`,
        () => writeCaps({ ...(body?.dailyTokens !== undefined ? { dailyTokens: body.dailyTokens } : {}), ...(body?.runTokens !== undefined ? { runTokens: body.runTokens } : {}) }, this.capsWriteDeps()));
      respond(response, outcome.status, outcome.body);
      return true;
    }

    if (path === '/command' && method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      const body = await readBody<{ text?: string }>(request);
      if (!body?.text) {
        respond(response, 400, { error: 'a command needs text' });
        return true;
      }
      const cards = await this.command(body.text);
      respond(response, 200, { cards });
      return true;
    }

    if ((match = path.match(/^\/proposals\/([^/]+)\/(apply|dismiss|restore)$/)) && method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      const id = decodeURIComponent(match[1]!);
      const action = match[2]!;
      const outcome = action === 'apply' ? applyRule(id, this.rulesDeps())
        : action === 'dismiss' ? dismissRule(id, this.rulesDeps())
          : restoreRule(id, this.rulesDeps());
      respond(response, outcome.status, outcome.body);
      return true;
    }

    if ((match = path.match(/^\/journal\/([^/]+)\/undo$/)) && method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      const jid = decodeURIComponent(match[1]!);
      const row = this.ledger.get(jid);
      if (!row) {
        respond(response, 404, { error: `no ledger row ${jid}` });
        return true;
      }
      if (row.undoneAt || !row.undo) {
        respond(response, 409, { error: `${jid} cannot be undone` });
        return true;
      }
      const result = await this.runUndo(row, row.undo);
      if (result.status === 200) this.ledger.markUndone(jid);
      respond(response, result.status, result.body);
      return true;
    }

    return false;
  }
}
