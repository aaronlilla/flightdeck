/**
 * The fixture server the UI, the vitest App test and the Playwright suite all
 * run against until the real routes land in `src/forge/server.ts` (S2/S3).
 * Serves every route in `src/shared/console-model.ts` from the seed fixtures
 * under `src/console/fixtures/`, mutating them in memory so a write behaves
 * the way the real server is meant to: kill kills, caps refuse above the hard
 * limit, an answer resumes a parked lane.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { CONSOLE_ROUTES, HEARTBEAT_MS } from '../shared/console-model.js';
import { computeNext } from '../forge/console/summary.js';
import { orderChains } from '../forge/console/blockers.js';
import type {
  ActionResult, Blocker, Caps, Integration, JournalEntry, Lane, LaneSummary, Message, QueueAddRequest,
  QueueAddResponse, QueueItem, QueueSource, ReauditResponse, Rule,
} from '../shared/console-model.js';
import { fmtTokens } from '../shared/format-tokens.js';
import { shortenShas } from '../shared/humanize.js';
import { tokenAmount } from '../forge/console/command.js';
import { sliceEventsFor } from '../shared/console-events.js';
import { seedCaps } from './fixtures/caps.js';
import { seedIntegrations } from './fixtures/integrations.js';
import { seedJournal } from './fixtures/journal.js';
import { seedLanes } from './fixtures/lanes.js';
import { seedRules } from './fixtures/proposals.js';
import {
  bigLanes, emptyLanes, emptyRules, galleryThread, healthyIntegrations, humanBoardLanes, matrixQueue, raceThread,
  refusalLanes, resumedRaceLanes, statesLanes, UNBUILT_REPO, longThread } from './fixtures/scenarios.js';
import { seedThread } from './fixtures/thread.js';

// `import.meta.url` is not always a `file:` URL under every test environment
// (jsdom's module graph rewrites it); this only ever needs to resolve when
// something actually asks for a static asset, so a bad URL here falls back
// to the working directory instead of failing every route in the file.
function distDir(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    return join(here, '..', '..', 'dist', 'console');
  } catch {
    return join(process.cwd(), 'dist', 'console');
  }
}
const DIST_DIR = distDir();
const PORT = Number(process.env['FORGE_STUB_PORT'] ?? 4130);
const TOKEN = process.env['FORGE_STUB_TOKEN'] ?? 'stub-token';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

interface Db {
  lanes: Lane[];
  thread: Message[];
  journal: JournalEntry[];
  integrations: Integration[];
  caps: Caps;
  rules: Rule[];
  jn: number;
  queue: QueueItem[];
  queuePaused: boolean;
  /** D2.3: set alongside `queuePaused` only when the (simulated) worker itself paused
   *  the queue, never an operator's own Pause click -- null the rest of the time. */
  queuePauseReason: string | null;
  /** Queue-throughput W2/W3: the width `POST /queue/width` changes and `GET /queue`
   *  reports back, so the console's own stepper has something real to talk to against
   *  this stub. Defaults to 4, matching the production default in `queue-wire.ts`. */
  queueMaxInFlight: number;
  qn: number;
  /** D2.4: `/state`'s own `queue_on` flag. Defaults `true` so every existing scenario
   *  and spec, none of which cares about this field, never sees the "Queue is off"
   *  banner it never asked for. */
  queueOn: boolean;
  /** 2026-09-07: the id of a lane this fixture wants `GET /run/:id/summary` to report
   *  as stale (its audit's head trailing the PR's own), or `null` when none should be.
   *  `POST /run/:id/reaudit` clears this for its own lane a couple seconds later, the
   *  stub's stand-in for a council round actually running and landing a fresh
   *  attestation. */
  staleAuditLane: string | null;
  /** Iteration 4: the Blockers view's own fixture data. Empty by default -- most
   *  scenarios have nothing to show there, and the `blockers-chain` fixture is what
   *  seeds a real three-step chain for its own Playwright coverage. */
  blockers: Blocker[];
}

/** The billing -> checks -> question chain the Blockers view spec (`tests/e2e/blockers.spec.ts`)
 *  drives step by step: resolving billing enables checks, resolving checks enables the
 *  question, and the whole chain collapses under "Resolved today" once the question is
 *  answered too. */
function seedBlockersChain(): Blocker[] {
  const now = Date.now() - 20 * 60_000;
  const lane = { laneId: 'S-stale-session', label: 'the stale-session fix' };
  return [
    {
      id: 'billing:aaronlilla/flightdeck', kind: 'billing', title: 'GitHub Actions billing is off for aaronlilla/flightdeck',
      detail: 'The verify jobs on PR #39 were refused in 3s: "recent account payments have failed or your '
        + 'spending limit needs to be increased".',
      youCanResolve: true, howToResolve: 'Turn billing back on at github.com/settings/billing, then click Resolved.',
      links: [{ label: 'GitHub billing settings', url: 'https://github.com/settings/billing' }],
      blocks: [lane], blockedBy: [], state: 'open', since: now, checkedAt: null, resolvedAt: null,
      thenWhat: 'Re-runs the checks on PR #39, then resumes the stale-session fix.', lastCheck: null,
    },
    {
      id: 'checks:aaronlilla/flightdeck#39', kind: 'checks', title: 'Checks failing on PR #39 (aaronlilla/flightdeck)',
      detail: 'PR #39 on aaronlilla/flightdeck has failing checks.', youCanResolve: true,
      howToResolve: 'Fix and push, or click Resolved to re-run checks.',
      links: [{ label: 'PR #39', url: 'https://github.com/aaronlilla/flightdeck/pull/39' }],
      blocks: [lane], blockedBy: ['billing:aaronlilla/flightdeck'], state: 'open', since: now, checkedAt: null,
      resolvedAt: null, thenWhat: 'Resumes the stale-session fix.', lastCheck: null,
    },
    {
      id: 'question:q1', kind: 'question', title: 'PR #39 is open. Can you fix billing?',
      detail: 'PR #39 is open. Can you fix billing?', youCanResolve: true,
      howToResolve: 'Answer it from the rail or here.', links: [],
      blocks: [lane], blockedBy: ['checks:aaronlilla/flightdeck#39'], state: 'open', since: now, checkedAt: null,
      resolvedAt: null, thenWhat: 'Resumes the run once answered.', lastCheck: null,
    },
  ];
}

function seedDb(): Db {
  return {
    lanes: seedLanes(),
    thread: seedThread(),
    journal: seedJournal(),
    integrations: seedIntegrations(),
    caps: seedCaps(),
    rules: seedRules(),
    jn: 40221,
    queue: [],
    queuePaused: false,
    queuePauseReason: null,
    queueMaxInFlight: 4,
    qn: 0,
    queueOn: true,
    staleAuditLane: null,
    blockers: [],
  };
}

let db = seedDb();

// A kill/merge-ready confirm or plan card from `runCommand` below carries its own
// token in `btns` (the same shape as the real grammar in
// `src/forge/console/command.ts`), and Confirm/Run plan/Not now resolve here by
// that token rather than by the card's own `k` -- the rail routes a button's own
// `cmd` straight through, so the token this map is keyed on is exactly the text
// that comes back.
const pendingConfirms = new Map<string, () => Message[]>();
const pendingPlans = new Map<string, () => Message[]>();

/** The action a route-registered confirm runs once its token comes back, and the
 *  answer that route gives when it has. Mirrors `ConsoleWrites.confirmGate`. */
const pendingOutcomes = new Map<string, { status: number; body: unknown }>();

/**
 * The stub's copy of the real server's confirm gate: an irreversible route answers
 * 202 with a token and the same confirm card the grammar produces, and runs nothing
 * until the request comes back with `confirm: token`. A typed `confirm <token>` in
 * the rail resolves the same map entry.
 */
function gate(
  body: Record<string, unknown> | null | undefined, blast: string,
  act: () => { status: number; body: unknown },
): { status: number; body: unknown } {
  const token = body?.['confirm'];
  if (typeof token === 'string') {
    const pending = pendingConfirms.get(token);
    if (!pending) return { status: 409, body: { error: `nothing pending for ${token}` } };
    pendingConfirms.delete(token);
    const cards = pending();
    db.thread = [...db.thread, ...cards];
    const outcome = pendingOutcomes.get(token) ?? { status: 200, body: { ok: true, jid: null, message: cards[0]?.text ?? 'done', undoable: false } };
    pendingOutcomes.delete(token);
    return outcome;
  }
  const fresh = randomUUID();
  pendingConfirms.set(fresh, () => {
    const outcome = act();
    pendingOutcomes.set(fresh, outcome);
    const row = (outcome.body ?? {}) as { message?: string; error?: string; jid?: string | null; undoable?: boolean };
    const text = row.message ?? row.error ?? `answered ${outcome.status}`;
    return [outcome.status === 200
      ? { k: `r-${Date.now()}-${Math.random()}`, type: 'receipt', text, ts: Date.now(), source: 'console', jid: row.jid ?? undefined, undoable: row.undoable ?? false, resolved: 'ran' }
      : { k: `r-${Date.now()}-${Math.random()}`, type: 'refusal', text, ts: Date.now(), source: 'console' }];
  });
  const card: Message = {
    k: `confirm-${Date.now()}`, type: 'confirm', text: 'confirm?', ts: Date.now(), source: 'console', blast,
    btns: [
      { label: 'Confirm', cmd: `confirm ${fresh}`, cls: 'destroy' },
      { label: 'Not now', cmd: `dismiss ${fresh}` },
    ],
  };
  return { status: 202, body: { ok: false, pending: true, token: fresh, blast, card } };
}

/**
 * Named e2e scenarios, keyed the way `POST /__test/fixture?name=<id>` looks
 * them up. Each replaces the whole in-memory `db` with a purpose-built board,
 * so a spec that selects one starts from a known, isolated state regardless
 * of what any other spec file did to the default seed before it. `default`
 * (and any unknown name) falls back to `seedDb()`, the shape every non-e2e
 * caller of this stub already expects.
 */
const FIXTURES: Record<string, () => Db> = {
  default: seedDb,
  'empty-fleet': () => {
    const base = seedDb();
    return { ...base, lanes: emptyLanes(), rules: emptyRules(), thread: [], journal: [], integrations: healthyIntegrations(base.integrations) };
  },
  'states-matrix': () => ({ ...seedDb(), lanes: statesLanes() }),
  'refusal-501': () => ({ ...seedDb(), lanes: refusalLanes() }),
  'resume-race': () => ({ ...seedDb(), lanes: resumedRaceLanes(), thread: raceThread() }),
  'message-gallery': () => ({ ...seedDb(), thread: galleryThread() }),
  'long-thread': () => ({ ...seedDb(), thread: longThread() }),
  'big-fleet': () => ({ ...seedDb(), lanes: bigLanes() }),
  // H2.7: the human-UI board -- 31 lanes shaped like the real one this whole
  // stream was reported against, for every H2.1-H2.6 spec to share.
  'human-board': () => ({ ...seedDb(), lanes: humanBoardLanes() }),
  'queue-matrix': () => ({
    ...seedDb(),
    lanes: [],
    queue: matrixQueue(),
    // D2.3: stands in for A.2's own backoff -- three consecutive tick errors pausing
    // the queue on its own, distinct from an operator's own Pause click.
    queuePaused: true,
    queuePauseReason: 'tick-error backoff (3 consecutive failures)',
  }),
  // D2.4: the queue subsystem itself off, distinct from `queue-matrix`'s worker-paused
  // scenario above -- `/state`'s own `queue_on: false`.
  'queue-off': () => ({ ...seedDb(), queueOn: false }),
  // 2026-09-07: FLT-193 (a `done` lane with an open PR) reports a stale council audit --
  // its head has moved past the sha the attestation actually reviewed -- for the ticket
  // sheet summary block's own Playwright coverage.
  'summary-stale': () => ({ ...seedDb(), staleAuditLane: 'FLT-193' }),
  // Iteration 4: the Blockers view's own three-step chain (billing -> checks -> question).
  'blockers-chain': () => ({ ...seedDb(), blockers: seedBlockersChain() }),
};

function resetToFixture(name: string): void {
  const build = FIXTURES[name] ?? FIXTURES['default'];
  db = (build as () => Db)();
}

function nextJid(): string {
  db.jn += 1;
  return `J-${db.jn}`;
}

function journal(kind: string, text: string, run: string | null, undoable: boolean): string {
  const jid = nextJid();
  db.journal = [{ jid, ts: Date.now(), kind, text, actor: 'console', run, undoable, undone: false }, ...db.journal];
  return jid;
}

function appendEvent(text: string, lane?: string): void {
  db.thread = [...db.thread, { k: `evt-${Date.now()}-${Math.random()}`, type: 'event', text, ts: Date.now(), source: 'system', lane, verifiedAt: Date.now() }];
}

function findLane(id: string): Lane | undefined {
  return db.lanes.find((l) => l.id === id);
}

/** A per-step cost breakdown built from the fixture lane's own turn count, the closest
 *  the stub can get to the real server's per-turn usage rows without a real journal. */
function stubCostSteps(lane: Lane): { t: number; stepText: string; inputTokens: number; outputTokens: number; tokens: number }[] {
  const n = Math.max(1, lane.stepN);
  const steps = [];
  for (let i = 1; i <= n; i += 1) {
    const runaway = lane.runaway && i === n;
    const frac = runaway ? 0.92 : 1 / n;
    const stepTokens = Math.round(lane.tokens * frac);
    // 4:1 input:output is a plausible agentic-coding split (a run reads far more than it
    // writes) -- not measured, since the stub has no real per-turn usage rows, but real
    // enough that the two halves sum back to `stepTokens` exactly, matching the real
    // server's own invariant instead of two independently-guessed numbers.
    const inputTokens = Math.round(stepTokens * 0.8);
    steps.push({
      t: lane.startedAt + i * 8 * 60_000,
      stepText: runaway ? `retry loop · ${lane.fails} failed builds` : `step ${i}/${lane.stepTotal}`,
      inputTokens,
      outputTokens: stepTokens - inputTokens,
      tokens: stepTokens,
    });
  }
  return steps;
}

/** The ticket sheet's journal narrative, built the same shape the real server computes
 *  from the journal (see `src/forge/console/journal-narrative.ts`), off this fixture
 *  lane's own fields since the stub has no real journal to read from. */
function stubJournalNarrative(lane: Lane): { t: number; text: string; color: string }[] {
  const entries: { t: number; text: string; color: string }[] = [
    { t: lane.startedAt, text: `polled ${lane.id} from queue`, color: 'var(--ink2)' },
  ];
  if (!lane.sandbox) {
    entries.push({ t: lane.startedAt + 60_000, text: 'provision failed · AWS sandboxes disconnected', color: 'var(--block)' });
  } else {
    entries.push({ t: lane.startedAt + 60_000, text: `sandbox ${lane.sandbox.id} provisioned`, color: 'var(--ink2)' });
    entries.push({ t: lane.startedAt + 180_000, text: `branch ${lane.id.toLowerCase()} pushed · ${lane.model}`, color: 'var(--ink2)' });
  }
  if (lane.hop >= 3) entries.push({ t: lane.since - 60_000, text: 'gate opened · council judge ×3', color: 'var(--ink2)' });
  if (lane.state === 'parked') entries.push({ t: lane.since, text: 'parked — needs human', color: 'var(--park)' });
  else if (lane.state === 'merged') entries.push({ t: lane.since, text: 'merged → main · jira updated', color: 'var(--merge)' });
  else if (lane.state === 'killed') entries.push({ t: lane.since, text: 'killed · diff discarded', color: 'var(--block)' });
  else if (lane.runaway) entries.push({ t: Date.now(), text: `build failing ×${lane.fails} · ${fmtTokens(lane.tokens)} tokens`, color: 'var(--block)' });
  return entries;
}

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A run-id-shaped string for this lane, for the verbose fixture rows -- not the
 *  lane's own real id, since a jira_-style id already carries a ticket key that
 *  would make the machine-id regex match `plain` fixtures for the wrong reason. */
function syntheticRunId(lane: Lane): string {
  return `S-${createHash('sha1').update(lane.id).digest('hex').slice(0, 16)}`;
}

/**
 * Item 9: `/run/:id/thread` parity with the real contract -- plain by default (tool
 * calls folded into one `activity` digest, a `reply` with the lane's own plain
 * sentence, an `Asked you:` event for a parked lane's question, no machine id
 * anywhere in the text), raw rows with ids intact under `?verbose=1`.
 */
function runThreadPlain(lane: Lane): Message[] {
  // The lane's own persisted messages (`db.thread`, filtered to this lane) stay --
  // a pending question with its answer options is a real, interactive card, never
  // something a digest is allowed to swallow -- the synthetic activity/reply/asked
  // rows lead the thread, ahead of whatever real cards this lane already carries.
  const persisted = db.thread.filter((m) => m.lane === lane.id);
  const messages: Message[] = [
    {
      k: `${lane.id}-activity`, type: 'activity',
      text: `Worked ${hhmm(lane.startedAt)} to ${hhmm(lane.observedAt)}: 140 commands, 45 file reads, 11 edits.`,
      ts: lane.observedAt, source: lane.id,
    },
    { k: `${lane.id}-reply`, type: 'reply', text: shortenShas(lane.plain || lane.stepText), ts: lane.observedAt, source: 'conductor' },
  ];
  if (lane.question && !persisted.some((m) => m.type === 'question')) {
    messages.push({
      k: `${lane.id}-asked`, type: 'event', text: `Asked you: ${lane.question.text}`,
      ts: lane.question.askedAt, source: lane.id,
    });
  }
  return [...messages, ...persisted];
}

function runThreadVerbose(lane: Lane): Message[] {
  const rid = syntheticRunId(lane);
  const persisted = db.thread.filter((m) => m.lane === lane.id);
  const messages: Message[] = [
    { k: `${rid}-started`, type: 'event', text: `${rid} STARTED`, ts: lane.startedAt, source: lane.id },
    { k: `${rid}-bash1`, type: 'event', text: `${rid} RUNNING BASH`, ts: lane.startedAt + 60_000, source: lane.id },
    { k: `${rid}-bash2`, type: 'event', text: `${rid} RUNNING BASH`, ts: lane.startedAt + 120_000, source: lane.id },
    {
      k: `${rid}-receipt`, type: 'receipt', text: `${rid} finished a tool call`, ts: lane.observedAt, source: 'console',
      jid: `J-${rid.slice(2, 10)}`, undoable: false,
    },
  ];
  if (lane.question && !persisted.some((m) => m.type === 'question')) {
    messages.push({
      k: `${rid}-ask`, type: 'question', text: lane.question.text, ts: lane.question.askedAt, source: lane.id,
      askKey: lane.question.key, opts: lane.question.opts,
    });
  }
  return [...messages, ...persisted];
}

/** H2.4: the ticket sheet's Story section (`GET /run/:id/story`) -- built off this
 *  fixture lane's own fields, the same stand-in approach `stubJournalNarrative`
 *  already takes for the journal panel. */
function stubStory(lane: Lane | undefined, id: string, verbose = false): import('../shared/console-model.js').LaneStory {
  if (!lane) {
    return { id, title: null, kind: 'manual', ticket: null, brief: null, entries: [] };
  }
  // Item 9: plain mode never names the run id -- a lane with no ticket reads "this
  // run" the same way `stripMachineIds` would; verbose mode names it in full.
  const startedOn = lane.ticket ?? (verbose ? lane.id : 'this run');
  const entries: import('../shared/console-model.js').LaneStoryEntry[] = [
    { at: lane.startedAt, kind: 'ticket', text: `started on ${startedOn}`, url: lane.sourceUrl },
  ];
  if (lane.sandbox) entries.push({ at: lane.startedAt + 60_000, kind: 'branch', text: `branch ${lane.sandbox.branch ?? lane.id.toLowerCase()} pushed`, url: null });
  if (lane.pr) entries.push({ at: lane.since - 30_000, kind: 'pr', text: `opened PR #${lane.pr.no}`, url: lane.pr.url });
  if (lane.state === 'parked' && lane.question) entries.push({ at: lane.since, kind: 'park', text: `parked: ${lane.question.text}`, url: null });
  else if (lane.state === 'merged') entries.push({ at: lane.since, kind: 'merge', text: 'merged into develop', url: lane.pr?.url ?? null });
  else if (lane.state === 'killed') entries.push({ at: lane.since, kind: 'end', text: 'killed', url: null });
  return {
    id: lane.id,
    title: lane.title,
    kind: lane.kind,
    ticket: lane.ticket ? { key: lane.ticket, url: lane.sourceUrl, summary: lane.title } : null,
    brief: lane.title ? { path: `briefs/${lane.ticket ?? lane.id}.md`, excerpt: lane.title } : null,
    entries,
  };
}

/** 2026-09-07: the ticket sheet's Summary block (`GET`/`POST /run/:id/{summary,recheck}`),
 *  built off this fixture lane's own fields, the same stand-in approach `stubStory`
 *  already takes. A lane the fixture has flagged in `db.staleAuditLane` reports a stale
 *  audit and un-ready drift; every other lane with a PR reports a clean one. */
function stubSummary(lane: Lane | undefined, id: string): LaneSummary {
  if (!lane) return { what: [], status: 'no such run', next: 'Nothing to do; this run is not on the board.', audit: null, readiness: null };
  const what: string[] = [];
  if (lane.title) what.push(`${lane.title}.`);
  what.push(`${lane.stepText}.`.replace(/\.\.$/, '.'));
  const pr = lane.pr;
  if (!pr) {
    const readiness = { ok: false, why: 'no PR is open yet', checks: null, behindBase: null, headMoved: false };
    return {
      what, status: shortenShas(lane.plain || `${lane.stepText}.`), next: computeNext(lane, readiness), audit: null, readiness,
    };
  }
  const stale = db.staleAuditLane === lane.id;
  const audit = {
    verdict: pr.merged ? 'PASS' : 'PASS WITH NOTES',
    reviewed: 4,
    total: 4,
    at: lane.since - 5 * 60_000,
    head: stale ? 'a1b2c3d0000000000000000000000000000000d' : 'a1b2c3d1111111111111111111111111111111d',
    findings: pr.merged ? 0 : 2,
    findingsText: pr.merged ? [] : ['reviewer: the retry loop can double-charge on a timeout', 'reviewer: no test covers the empty-body case'],
    stale,
    staleWhy: stale ? 'the PR head has moved since this audit ran' : null,
  };
  const behindBase = stale ? 3 : 0;
  const ok = !stale && behindBase === 0 && pr.checks !== 'failure' && !pr.merged;
  const why = pr.merged
    ? 'already merged'
    : stale
      ? 'the PR head moved since the audit'
      : pr.checks === 'failure'
        ? 'checks are failure'
        : null;
  const readiness = { ok, why: ok ? null : why, checks: pr.checks ?? 'success', behindBase, headMoved: stale };
  return {
    what,
    status: shortenShas(lane.plain || `${lane.stepText}.`),
    next: computeNext(lane, readiness),
    audit,
    readiness,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readBody(request);
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function ok(jid: string, message: string, undoable: boolean, lane?: Lane): ActionResult {
  return { ok: true, jid, message, undoable, lane };
}

function newQueueItem(source: QueueSource, input: string, ticket: string | null): QueueItem {
  db.qn += 1;
  const now = Date.now();
  return {
    id: `Q-stub-${db.qn}`, source, input, ticket, repo: null, briefPath: null, branch: null,
    worktreePath: null, base: null, state: 'queued', reason: null, runKey: null, pr: null,
    journalIds: [], createdAt: now, updatedAt: now,
  };
}

/** The stub's own stand-in for a real JQL search: deterministic, no network, two ticket
 *  keys derived from the query text so a `query`/`backlog` add has something to show. */
function fakeSearchKeys(jql: string): string[] {
  const slug = jql.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase().slice(0, 12) || 'ITEM';
  return [`${slug}-1`, `${slug}-2`];
}

/**
 * The stub's own fake worker: a real `forge up` plans, provisions, launches and gates an
 * item through `intake/queue.ts#advanceItem` against real dependencies; this stub has
 * none of those, so it simulates the same three hops on a short timer instead --
 * `queued` -> `running` -> `review`, with a fake draft PR -- so the console's own queue
 * view can be driven end to end (add an item, watch it land in review) with nothing
 * behind it but this fixture.
 */
function fakeAdvance(item: QueueItem): void {
  setTimeout(() => {
    const row = db.queue.find((q) => q.id === item.id);
    if (!row || row.state !== 'queued') return;
    row.state = 'running';
    row.repo = 'example/repo';
    row.updatedAt = Date.now();
  }, 400);
  setTimeout(() => {
    const row = db.queue.find((q) => q.id === item.id);
    if (!row || row.state !== 'running') return;
    db.qn += 1;
    row.state = 'review';
    row.pr = { no: db.qn, url: `https://github.com/example/repo/pull/${db.qn}`, files: 3, add: 42, del: 6, draft: true };
    row.updatedAt = Date.now();
  }, 1200);
}

function addQueueItem(body: QueueAddRequest): QueueAddResponse {
  if (!body || !body.input || !body.input.trim()) {
    return { ok: false, items: [], error: 'a queue add needs a source and input' };
  }
  if (body.source === 'ticket') {
    const item = newQueueItem('ticket', body.input.trim(), body.input.trim());
    db.queue = [...db.queue, item];
    fakeAdvance(item);
    return { ok: true, items: [item] };
  }
  if (body.source === 'brief') {
    const item = newQueueItem('brief', body.input, null);
    db.queue = [...db.queue, item];
    fakeAdvance(item);
    return { ok: true, items: [item] };
  }
  if (body.source === 'query' || body.source === 'backlog') {
    const items = fakeSearchKeys(body.input).map((key) => newQueueItem(body.source, body.input, key));
    db.queue = [...db.queue, ...items];
    for (const item of items) fakeAdvance(item);
    return { ok: true, items };
  }
  return { ok: false, items: [], error: `unknown source ${String(body.source)}` };
}

/** `POST /blockers/:id/resolve` and `.../check`'s fixture behaviour: a step earlier in
 *  its own chain still open refuses the claim, an already-resolved blocker is a no-op
 *  echo, and a genuine resolve marks it done and restarts the lane once nothing else in
 *  its chain still blocks it -- the same "one at a time, in order" rule the real
 *  `BlockersRoutes` enforces (`src/forge/console/blockers-route.ts`). */
function resolveBlockerFixture(id: string, claim: boolean): { ok: boolean; state: string; lastCheck: string | null; started: string[] } {
  const blocker = db.blockers.find((b) => b.id === id);
  if (!blocker) return { ok: false, state: 'open', lastCheck: 'no such blocker', started: [] };
  if (blocker.state === 'resolved') return { ok: true, state: 'resolved', lastCheck: blocker.lastCheck, started: [] };
  const waitingOn = blocker.blockedBy.find((depId) => db.blockers.find((b) => b.id === depId)?.state !== 'resolved');
  if (waitingOn) {
    return { ok: false, state: 'open', lastCheck: `still waiting on ${waitingOn}`, started: [] };
  }
  if (claim && !blocker.youCanResolve) {
    return { ok: false, state: 'open', lastCheck: 'nothing to click here', started: [] };
  }
  if (!claim) {
    blocker.lastCheck = 'still open';
    blocker.checkedAt = Date.now();
    return { ok: false, state: 'open', lastCheck: blocker.lastCheck, started: [] };
  }
  blocker.state = 'resolved';
  blocker.resolvedAt = Date.now();
  blocker.checkedAt = blocker.resolvedAt;
  blocker.lastCheck = 'confirmed';
  const stillBlocked = new Set(
    db.blockers.filter((b) => b.state !== 'resolved').flatMap((b) => b.blocks.map((x) => x.laneId)),
  );
  const started = blocker.blocks.map((b) => b.laneId).filter((laneId) => !stillBlocked.has(laneId));
  return { ok: true, state: 'resolved', lastCheck: blocker.lastCheck, started };
}

function serveStatic(request: IncomingMessage, response: ServerResponse, urlPath: string): void {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const full = join(DIST_DIR, relative);
  if (!full.startsWith(DIST_DIR) || !existsSync(full)) {
    json(response, 404, { error: `nothing serves ${urlPath}. Did you run npm run console:build?` });
    return;
  }
  let text = readFileSync(full, 'utf8');
  if (extname(full) === '.html') {
    text = text.replace('<meta name="forge-token" content="" />', `<meta name="forge-token" content="${TOKEN}" />`);
  }
  const mime = MIME[extname(full)] ?? 'application/octet-stream';
  response.writeHead(200, { 'content-type': mime });
  response.end(text);
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  }
  return Buffer.concat([header, payload]);
}

const sockets = new Set<Duplex>();

function publish(event: Record<string, unknown>): void {
  const frame = textFrame(JSON.stringify(event));
  for (const socket of [...sockets]) {
    try { socket.write(frame); } catch { sockets.delete(socket); }
  }
}

function runCommand(text: string, run?: string): Message[] {
  const t = text.trim();
  const now = Date.now();
  const laneRefMatch = /\b([a-z]{2,4}-\d{2,4})\b/i.exec(t);
  const laneRef = laneRefMatch ? (laneRefMatch[1] as string).toUpperCase() : null;

  // The Conductor agent's shape (2026-09-08), as the stub plays it: `remove | archive |
  // retire <lane>` answers with a tool receipt first, then a confirm card, the way the
  // real agent streams a receipt per tool call before its reply; Confirm retires the
  // lane and it leaves the board. Rows the agent answers carry `path: 'agent'`.
  const removeMatch = /^(?:remove|archive|retire)\s+(\S+)$/i.exec(t);
  if (removeMatch) {
    const ref = (removeMatch[1] as string).toUpperCase();
    const lane = findLane(ref);
    if (!lane) return [{ k: `c-${now}`, type: 'reply', text: `No lane matches "${ref}". Pick one from the board.`, ts: now, source: 'conductor', path: 'agent' }];
    const token = randomUUID();
    pendingConfirms.set(token, () => {
      lane.retiredAt = Date.now();
      const jid = journal('lane.retired', `retired ${ref}`, ref, true);
      publish({ event: 'lane.retired', run: lane.id });
      return [{ k: `r-${Date.now()}`, type: 'receipt', text: `retired ${ref}`, ts: Date.now(), source: 'conductor', jid, undoable: true, path: 'agent' }];
    });
    return [
      { k: `r-${now}`, type: 'receipt', text: `remove proposed for ${ref}, waiting on Confirm`, ts: now, source: 'conductor', resolved: 'ran', path: 'agent' },
      { k: `c-${now}`, type: 'reply', text: `Proposed taking ${ref} off the board; it stays under Archived. The Confirm card is waiting for you.`, ts: now, source: 'conductor', path: 'agent' },
      {
        k: `confirm-${now}`, type: 'confirm', text: 'confirm?', ts: now, source: 'conductor', path: 'agent',
        blast: `${ref} leaves the board; it stays under Archived and can be brought back.`,
        btns: [
          { label: 'Confirm', cmd: `confirm ${token}`, cls: 'destroy' },
          { label: 'Not now', cmd: `dismiss ${token}` },
        ],
      },
    ];
  }

  // A stale token (the pending confirm/plan already ran, or the fixture reset
  // underneath it) reads the same as a token that was never valid.
  if (/^dismiss\s+(\S+)$/i.test(t)) {
    const token = (/^dismiss\s+(\S+)$/i.exec(t) as RegExpExecArray)[1] as string;
    if (pendingConfirms.delete(token) || pendingPlans.delete(token)) {
      return [{ k: `c-${now}`, type: 'reply', text: 'dismissed', ts: now, source: 'conductor' }];
    }
    return [{ k: `c-${now}`, type: 'refusal', text: `nothing pending for ${token}`, ts: now, source: 'conductor' }];
  }
  if (/^confirm\s+(\S+)$/i.test(t)) {
    const token = (/^confirm\s+(\S+)$/i.exec(t) as RegExpExecArray)[1] as string;
    const pending = pendingConfirms.get(token);
    if (!pending) return [{ k: `c-${now}`, type: 'refusal', text: `nothing pending for ${token}`, ts: now, source: 'conductor' }];
    pendingConfirms.delete(token);
    return pending();
  }
  if (/^run\s+(\S+)$/i.test(t)) {
    const token = (/^run\s+(\S+)$/i.exec(t) as RegExpExecArray)[1] as string;
    const pending = pendingPlans.get(token);
    if (!pending) return [{ k: `c-${now}`, type: 'refusal', text: `nothing pending for ${token}`, ts: now, source: 'conductor' }];
    pendingPlans.delete(token);
    return pending();
  }
  // Typed into a ticket sheet: the stub's agent tells that run, the way the old
  // composer delivered straight to its inbox, and says so.
  if (run) {
    const lane = db.lanes.find((l) => l.id === run);
    const label = lane?.ticket ?? run;
    if (!lane || !lane.heart) {
      return [{ k: `c-${now}`, type: 'reply', text: `${label} has no live session, so there is nobody to tell. Kill, verify or archive it instead.`, ts: now, source: 'conductor', path: 'agent' }];
    }
    return [
      { k: `r-${now}`, type: 'receipt', text: `sent to ${label}`, ts: now, source: 'conductor', resolved: 'ran', path: 'agent' },
      { k: `c-${now}`, type: 'reply', text: `Told ${label}: ${t}`, ts: now, source: 'conductor', path: 'agent' },
    ];
  }
  if (/^kill\b/i.test(t) && laneRef) {
    const lane = findLane(laneRef);
    if (!lane) return [{ k: `c-${now}`, type: 'refusal', text: `no lane named ${laneRef}`, ts: now, source: 'conductor' }];
    const token = randomUUID();
    pendingConfirms.set(token, () => {
      lane.state = 'killed'; lane.heart = false; lane.tokensPerMin = 0; lane.hopStatus = 'blocked';
      const jid = journal('run.killed', `${laneRef} killed`, laneRef, false);
      appendEvent(`${laneRef} killed`, laneRef);
      publish({ type: 'run.killed', run: laneRef });
      return [{ k: `r-${Date.now()}`, type: 'receipt', text: `${laneRef} killed`, ts: Date.now(), source: 'conductor', jid, undoable: false }];
    });
    return [{
      k: `confirm-${now}`, type: 'confirm', text: `Kill ${laneRef}?`, ts: now, source: 'conductor',
      blast: 'discards the working diff and stops the sandbox.',
      btns: [
        { label: 'Confirm', cmd: `confirm ${token}`, cls: 'destroy' },
        { label: 'Not now', cmd: `dismiss ${token}` },
      ],
    }];
  }
  if (/^merge ready lanes/i.test(t)) {
    const ready = db.lanes.filter((l) => l.state === 'done');
    if (ready.length === 0) return [{ k: `c-${now}`, type: 'reply', text: 'no lanes are ready to merge.', ts: now, source: 'conductor' }];
    const token = randomUUID();
    pendingPlans.set(token, () => ready.map((l) => {
      l.state = 'merged'; l.hop = 5; l.hopStatus = 'done';
      const jid = journal('chain.merged', `${l.id} merged`, l.id, false);
      appendEvent(`${l.id} merged`, l.id);
      publish({ type: 'chain.merged', run: l.id });
      return { k: `r-${Date.now()}-${l.id}`, type: 'receipt', text: `${l.id} merged`, ts: Date.now(), source: 'conductor', jid, undoable: false } as Message;
    }));
    return [{
      k: `plan-${now}`, type: 'plan', text: 'merge ready lanes', ts: now, source: 'conductor',
      items: ready.map((l) => ({ text: `merge ${l.id}`, irreversible: true })),
      btns: [
        { label: 'Run plan', cmd: `run ${token}`, cls: 'go' },
        { label: 'Not now', cmd: `dismiss ${token}` },
      ],
    }];
  }
  // Sweep #20: this used to capture only the leading digits and drop a `k`/`m`
  // suffix on the floor, so "raise daily cap to 50m tokens" set the cap to a literal
  // 50 tokens. `tokenAmount` is the same function the real grammar
  // (`src/forge/console/command.ts`) parses a typed amount with.
  const dailyCapMatch = /^(?:raise|set)\s+daily\s+cap\s+to\s+(\d+(?:\.\d+)?)([km])?/i.exec(t);
  if (dailyCapMatch) {
    const value = tokenAmount(dailyCapMatch[1] as string, dailyCapMatch[2]);
    if (value > db.caps.hardTokens) {
      return [{ k: `c-${now}`, type: 'refusal', text: `refused: ${fmtTokens(value)} tokens is above the org hard limit ${fmtTokens(db.caps.hardTokens)} tokens (FD-7)`, ts: now, source: 'conductor' }];
    }
    db.caps = { ...db.caps, dailyTokens: value };
    const jid = journal('caps.set', `daily cap set to ${fmtTokens(value)} tokens`, null, true);
    return [{ k: `r-${now}`, type: 'receipt', text: `daily cap set to ${fmtTokens(value)} tokens`, ts: now, source: 'conductor', jid, undoable: true }];
  }
  const runCapCommandMatch = /^cap\s+\S+\s+at\s+(\d+(?:\.\d+)?)([km])?/i.exec(t);
  if (runCapCommandMatch && laneRef) {
    const value = tokenAmount(runCapCommandMatch[1] as string, runCapCommandMatch[2]);
    if (value > db.caps.hardTokens) {
      return [{ k: `c-${now}`, type: 'refusal', text: `refused: ${fmtTokens(value)} tokens is above the org hard limit ${fmtTokens(db.caps.hardTokens)} tokens (FD-7)`, ts: now, source: 'conductor' }];
    }
    const lane = findLane(laneRef);
    if (lane) lane.tokenCap = value;
    const jid = journal('run.cap.set', `${laneRef} cap set to ${fmtTokens(value)} tokens`, laneRef, true);
    return [{ k: `r-${now}`, type: 'receipt', text: `${laneRef} cap set to ${fmtTokens(value)} tokens`, ts: now, source: 'conductor', jid, undoable: true }];
  }
  if (/^answer\b/i.test(t)) {
    const rest = t.replace(/^answer\s*/i, '');
    const parked = db.lanes.find((l) => l.state === 'parked' && l.question);
    if (!parked || !parked.question) return [{ k: `c-${now}`, type: 'reply', text: 'nothing is parked right now.', ts: now, source: 'conductor' }];
    const answerText = rest.replace(new RegExp(`^${parked.question.key}\\s*`), '').trim() || rest.trim();
    parked.state = 'running';
    parked.heart = true;
    parked.question = null;
    const jid = journal('ask.answered', `${parked.id} answered: ${answerText}`, parked.id, false);
    appendEvent(`${parked.id} resumed`, parked.id);
    return [{ k: `r-${now}`, type: 'receipt', text: `${parked.id} resumed: ${answerText}`, ts: now, source: 'conductor', jid, undoable: false }];
  }
  if (/what's stuck|whats stuck/i.test(t)) {
    const stuck = db.lanes.filter((l) => l.state === 'blocked' || l.state === 'parked');
    return [{ k: `c-${now}`, type: 'reply', text: stuck.length ? stuck.map((l) => l.id).join(', ') : 'nothing is stuck.', ts: now, source: 'conductor' }];
  }
  if (/^why is/i.test(t) && laneRef) {
    const lane = findLane(laneRef);
    return [{ k: `c-${now}`, type: 'reply', text: lane?.reason ?? `${laneRef} has no recorded reason.`, ts: now, source: 'conductor' }];
  }
  if (/spend today/i.test(t)) {
    return [{ k: `c-${now}`, type: 'reply', text: `${fmtTokens(db.caps.tokensToday)} tokens of a ${fmtTokens(db.caps.dailyTokens)} daily cap.`, ts: now, source: 'conductor' }];
  }
  if (/^status/i.test(t)) {
    const running = db.lanes.filter((l) => l.state === 'running').length;
    return [{ k: `c-${now}`, type: 'reply', text: `${running} running, ${db.lanes.length} lanes total.`, ts: now, source: 'conductor' }];
  }
  return [{ k: `c-${now}`, type: 'reply', text: "I understand pause, resume, kill <lane>, merge ready lanes, cap <lane> at N tokens, answer, what's stuck, spend today, status.", ts: now, source: 'conductor' }];
}

let stubBuild = 'stub-1';
export function setStubBuild(build: string): void { stubBuild = build; }
export function createStubServer() {
  const server = createServer((request, response) => {
    void (async () => {
      const urlPath = (request.url ?? '/').split('?')[0] ?? '/';
      const query = new URLSearchParams((request.url ?? '').split('?')[1] ?? '');
      const method = request.method ?? 'GET';
      // The live spine, the same way the real server does it (`server.ts#route`).
      response.once('finish', () => {
        const events = sliceEventsFor(method, urlPath, response.statusCode);
        if (events) for (const event of events) publish(event);
      });

      // Test-only: an e2e spec selects its own isolated board before it navigates,
      // rather than mutating (or depending on) whatever the default seed or another
      // spec file left behind. Never reachable from the built console itself.
      if (urlPath === '/__test/fixture' && method === 'POST') {
        resetToFixture(query.get('name') ?? 'default');
        json(response, 200, { ok: true, name: query.get('name') ?? 'default' });
        return;
      }

      // The real server checks `x-forge-token` on every read and write except
      // `/state` (`server.ts#authorized`, `route()`'s own comment on
      // `ConsoleReads`) -- matched here so a wrong token 401s exactly the way it
      // would against the real server. Only rejected when the header is
      // present, non-empty and wrong: the built console always sends the real
      // token (its own `<meta name="forge-token">` is filled in server-side
      // before the page ever loads, same as the real server does), but
      // tests/console/app.test.tsx renders <App> straight into jsdom with no
      // such meta tag in the document, so `api.ts#token()` falls back to `''`
      // there, and tests/console/stub-server.test.ts calls these routes
      // directly with no header at all. Both stay unauthenticated, the way a
      // same-process caller reasonably can; only an actually-wrong, non-empty
      // token 401s.
      // Static assets (the built console's own HTML/JS/CSS) stay unauthenticated,
      // same as `serveStatic` on the real server.
      const isStaticAsset = method === 'GET' && !CONSOLE_ROUTES.some((route) => urlPath === route)
        && !urlPath.startsWith('/run/') && urlPath !== '/queue';
      const sentToken = request.headers['x-forge-token'];
      if (!isStaticAsset && sentToken && sentToken !== TOKEN) {
        json(response, 401, { error: 'missing or wrong X-Forge-Token' });
        return;
      }

      // D2.4: the one field of the real server's own `/state` the web console needs.
      // Not in `CONSOLE_ROUTES` (same as the real server: `/state` carries no token).
      if (urlPath === '/state' && method === 'GET') {
        json(response, 200, { queue_on: db.queueOn, build: stubBuild, conductor: { enabled: true, timeoutMs: 120_000, open: false } });
        return;
      }

      if (urlPath === '/lanes' && method === 'GET') {
        // H2.2: `archived=1` answers only the retired lanes -- a separate slot from the
        // live board, never mixed into the default/`all=1` response.
        const links = { jiraSite: 'https://acme.atlassian.net', defaultRepo: db.lanes.find((l) => l.repo)?.repo ?? null };
        if (query.get('archived') === '1') {
          const archived = db.lanes.filter((l) => l.retiredAt !== null);
          json(response, 200, { at: Date.now(), lanes: archived, tokensToday: 0, tokensPerMin: 0, links });
          return;
        }
        // Matches the real server (ConsoleReads#lanesResponse): the default/`all=1`
        // view never carries a retired lane -- that is `archived=1`'s own slot above.
        const live = db.lanes.filter((l) => l.retiredAt === null);
        const tokensToday = live.reduce((sum, l) => sum + l.tokens, 0);
        const tokensPerMin = live.reduce((sum, l) => sum + (l.state === 'running' ? l.tokensPerMin : 0), 0);
        json(response, 200, { at: Date.now(), lanes: live, tokensToday, tokensPerMin, links });
        return;
      }
      if (urlPath === '/thread' && method === 'GET') {
        json(response, 200, { messages: db.thread });
        return;
      }
      if (urlPath === '/journal' && method === 'GET') {
        const since = query.has('since') ? Number(query.get('since')) : undefined;
        const run = query.get('run') ?? undefined;
        const limit = query.has('limit') ? Number(query.get('limit')) : undefined;
        let rows = db.journal;
        if (since !== undefined) rows = rows.filter((r) => r.ts >= since);
        if (run !== undefined) rows = rows.filter((r) => r.run === run);
        const total = rows.length;
        if (limit !== undefined) rows = rows.slice(0, limit);
        json(response, 200, { rows, total });
        return;
      }
      if (urlPath === '/integrations' && method === 'GET') {
        json(response, 200, { items: db.integrations, checkedAt: Date.now(), everyS: 30 });
        return;
      }
      if (urlPath === '/caps' && method === 'GET') {
        json(response, 200, db.caps);
        return;
      }
      if (urlPath === '/proposals' && method === 'GET') {
        const mergedToday = db.lanes.filter((l) => l.state === 'merged').length;
        const metrics = { mergedToday, humanWaitMin: 8, tokensPerMerge: mergedToday > 0 ? db.caps.tokensToday / mergedToday : null, tokensWasted: 2_480_000 };
        json(response, 200, { rules: db.rules, metrics, computedAt: Date.now() });
        return;
      }
      // H2.3: `/retire-finished` -- a done/merged/killed/probe lane with no open PR is
      // a candidate. GET previews it, POST retires it (sets `retiredAt`).
      const RETIRABLE_STATES = new Set(['done', 'merged', 'killed']);
      const retirable = (): Lane[] => db.lanes.filter((l) => (
        l.retiredAt === null && (RETIRABLE_STATES.has(l.state) || l.kind === 'probe') && (!l.pr || l.pr.merged !== false)
      ));
      if (urlPath === '/retire-finished' && method === 'GET') {
        json(response, 200, { items: retirable().map((l) => ({ id: l.id, title: l.title })) });
        return;
      }
      if (urlPath === '/retire-finished' && method === 'POST') {
        const retireBody = await readJson<Record<string, unknown>>(request);
        const preview = retirable();
        const gated = gate(retireBody, `retires ${preview.length} finished lane${preview.length === 1 ? '' : 's'}: ${preview.map((l) => l.title ?? l.id).join(', ') || 'nothing'}`, () => {
          const targets = retirable();
          const now = Date.now();
          for (const l of targets) l.retiredAt = now;
          return { status: 200, body: { ok: true, jid: null, message: `retired ${targets.length} lane(s)`, undoable: false, retired: targets.map((l) => l.id) } };
        });
        json(response, gated.status, gated.body);
        return;
      }
      // H2.3: `/merge-ready` -- a `done` lane is ready when it carries no `mergeable`
      // refusal; GET previews the split, POST merges every ready one.
      const mergeSplit = (): { ready: Lane[]; notReady: { lane: Lane; why: string }[] } => {
        const ready: Lane[] = [];
        const notReady: { lane: Lane; why: string }[] = [];
        for (const l of db.lanes) {
          if (l.state !== 'done') continue;
          if (l.mergeable && l.mergeable.ok === false) notReady.push({ lane: l, why: l.mergeable.why });
          else ready.push(l);
        }
        return { ready, notReady };
      };
      if (urlPath === '/merge-ready' && method === 'GET') {
        const { ready, notReady } = mergeSplit();
        json(response, 200, {
          ready: ready.map((l) => ({ id: l.id, title: l.title, pr: l.pr })),
          notReady: notReady.map(({ lane: l, why }) => ({ id: l.id, title: l.title, pr: l.pr, why })),
        });
        return;
      }
      if (urlPath === '/merge-ready' && method === 'POST') {
        // Matches the real server's POST /merge-ready shape (src/forge/server.ts
        // mergeReadyPost): an ActionResult plus {outcomes: [{id, ok, message}]}, one
        // entry per ready lane actually attempted, behind the same confirm gate.
        const mergeReadyBody = await readJson<Record<string, unknown>>(request);
        const readyNow = mergeSplit().ready;
        const gated = gate(mergeReadyBody, `merges ${readyNow.length} ready lane${readyNow.length === 1 ? '' : 's'}: ${readyNow.map((l) => l.title ?? l.id).join(', ') || 'nothing'}`, () => {
          const { ready } = mergeSplit();
          const outcomes: { id: string; ok: boolean; message: string }[] = [];
          for (const l of ready) {
            l.state = 'merged'; l.hop = 5; l.hopStatus = 'done';
            journal('chain.merged', `${l.id} merged`, l.id, false);
            outcomes.push({ id: l.id, ok: true, message: `merged ${l.id}` });
          }
          return { status: 200, body: { ok: outcomes.every((row) => row.ok), jid: null, message: `merged ${outcomes.length} lane${outcomes.length === 1 ? '' : 's'}`, undoable: false, outcomes } };
        });
        json(response, gated.status, gated.body);
        return;
      }

      const runStoryMatch = /^\/run\/([^/]+)\/story$/.exec(urlPath);
      if (runStoryMatch && method === 'GET') {
        const id = decodeURIComponent(runStoryMatch[1] as string);
        const l = findLane(id);
        json(response, 200, stubStory(l, id, query.get('verbose') === '1'));
        return;
      }

      const runSummaryMatch = /^\/run\/([^/]+)\/summary$/.exec(urlPath);
      if (runSummaryMatch && method === 'GET') {
        const id = decodeURIComponent(runSummaryMatch[1] as string);
        json(response, 200, stubSummary(findLane(id), id));
        return;
      }

      if (urlPath === '/queue' && method === 'GET') {
        json(response, 200, { items: db.queue, paused: db.queuePaused, maxInFlight: db.queueMaxInFlight, pauseReason: db.queuePauseReason });
        return;
      }

      if (urlPath === '/blockers' && method === 'GET') {
        const open = db.blockers.filter((b) => b.state !== 'resolved');
        json(response, 200, { blockers: db.blockers, chains: orderChains(open) });
        return;
      }

      const runThreadMatch = /^\/run\/([^/]+)\/thread$/.exec(urlPath);
      if (runThreadMatch && method === 'GET') {
        const id = decodeURIComponent(runThreadMatch[1] as string);
        const verbose = query.get('verbose') === '1';
        const lane = findLane(id);
        const messages = lane ? (verbose ? runThreadVerbose(lane) : runThreadPlain(lane)) : [];
        json(response, 200, verbose ? { messages, verbose: true } : { messages });
        return;
      }
      const runPrMatch = /^\/run\/([^/]+)\/pr$/.exec(urlPath);
      if (runPrMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runPrMatch[1] as string));
        json(response, 200, { pr: lane?.pr ?? null });
        return;
      }
      const runSandboxMatch = /^\/run\/([^/]+)\/sandbox$/.exec(urlPath);
      if (runSandboxMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runSandboxMatch[1] as string));
        const log = lane?.sandbox
          ? [
            { text: `${new Date().toISOString()} sandbox ready`, severity: 'info' as const },
            { text: `${new Date().toISOString()} ${lane.stepText}`, severity: 'progress' as const },
            ...(lane.fails > 0 ? [{ text: `${new Date().toISOString()} retrying after a failed build`, severity: 'retry' as const }] : []),
            ...(lane.runaway ? [{ text: `${new Date().toISOString()} build failed: exit 1`, severity: 'error' as const }] : []),
          ]
          : [];
        json(response, 200, { sandbox: lane?.sandbox ?? null, log });
        return;
      }
      const runCostMatch = /^\/run\/([^/]+)\/cost$/.exec(urlPath);
      if (runCostMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runCostMatch[1] as string));
        json(response, 200, {
          steps: lane ? stubCostSteps(lane) : [],
          capEnforcementFailedJid: lane?.runaway ? 'J-40211' : null,
        });
        return;
      }
      const runJournalMatch = /^\/run\/([^/]+)\/journal$/.exec(urlPath);
      if (runJournalMatch && method === 'GET') {
        const lane = findLane(decodeURIComponent(runJournalMatch[1] as string));
        json(response, 200, { entries: lane ? stubJournalNarrative(lane) : [] });
        return;
      }

      const runKillMatch = /^\/run\/([^/]+)\/kill$/.exec(urlPath);
      if (runKillMatch && method === 'POST') {
        const id = decodeURIComponent(runKillMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        const killBody = await readJson<Record<string, unknown>>(request);
        const gated = gate(killBody, `kills ${id}: discards the working diff and stops the sandbox.`, () => {
          lane.state = 'killed'; lane.heart = false; lane.tokensPerMin = 0; lane.hopStatus = 'blocked';
          const jid = journal('run.killed', `${id} killed`, id, false);
          appendEvent(`${id} killed`, id);
          publish({ type: 'run.killed', run: id });
          return { status: 200, body: ok(jid, `${id} killed`, false, lane) };
        });
        json(response, gated.status, gated.body);
        return;
      }
      const runPauseMatch = /^\/run\/([^/]+)\/pause$/.exec(urlPath);
      if (runPauseMatch && method === 'POST') {
        const id = decodeURIComponent(runPauseMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'paused'; lane.heart = false;
        const jid = journal('run.paused', `${id} paused`, id, true);
        json(response, 200, ok(jid, `${id} paused`, true, lane));
        return;
      }
      const runResumeMatch = /^\/run\/([^/]+)\/resume$/.exec(urlPath);
      if (runResumeMatch && method === 'POST') {
        const id = decodeURIComponent(runResumeMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'running'; lane.heart = true; lane.verifiedAt = Date.now();
        const jid = journal('run.resumed', `${id} resumed`, id, false);
        json(response, 200, ok(jid, `${id} resumed`, false, lane));
        return;
      }
      const runMergeMatch = /^\/run\/([^/]+)\/merge$/.exec(urlPath);
      if (runMergeMatch && method === 'POST') {
        const id = decodeURIComponent(runMergeMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        const mergeBody = await readJson<Record<string, unknown>>(request);
        const gated = gate(mergeBody, `merges ${id}: merges the PR and closes the ticket.`, () => {
          lane.state = 'merged'; lane.hop = 5; lane.hopStatus = 'done';
          const jid = journal('chain.merged', `${id} merged`, id, false);
          appendEvent(`${id} merged`, id);
          publish({ type: 'chain.merged', run: id });
          return { status: 200, body: ok(jid, `${id} merged`, false, lane) };
        });
        json(response, gated.status, gated.body);
        return;
      }
      // H2.2/H2.3: a per-lane undo of a retire -- not in the frozen contract (only
      // the bulk `/retire-finished` is), a stub-only convenience the real server
      // needs an equivalent route for once it grows a single-lane retire of its own.
      const runUnretireMatch = /^\/run\/([^/]+)\/unretire$/.exec(urlPath);
      if (runUnretireMatch && method === 'POST') {
        const id = decodeURIComponent(runUnretireMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.retiredAt = null;
        const jid = journal('run.unretired', `${id} unretired`, id, false);
        json(response, 200, ok(jid, `${id} unretired`, false, lane));
        return;
      }
      const runReopenMatch = /^\/run\/([^/]+)\/reopen$/.exec(urlPath);
      if (runReopenMatch && method === 'POST') {
        const id = decodeURIComponent(runReopenMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'running'; lane.attempt += 1; lane.fails = 0; lane.runaway = false; lane.heart = true;
        const jid = journal('run.reopened', `${id} reopened (attempt ${lane.attempt})`, id, false);
        json(response, 200, ok(jid, `${id} reopened`, false, lane));
        return;
      }
      const runCompactMatch = /^\/run\/([^/]+)\/compact$/.exec(urlPath);
      if (runCompactMatch && method === 'POST') {
        const id = decodeURIComponent(runCompactMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        // The contract's 501 case (`console-model.ts`'s route table): a write whose
        // mechanism the real server has not built yet, so the rail renders a refusal
        // card instead of a fake success. `UNBUILT_REPO` is the `refusal-501` e2e
        // scenario's own sentinel, never a repo any lane actually carries.
        if (lane.repo === UNBUILT_REPO) {
          json(response, 501, { error: 'compaction has no successor worker built yet', reason: 'not-implemented' });
          return;
        }
        lane.ctxTokens = Math.round(lane.ctxCeiling * 0.45); lane.state = 'running'; lane.heart = true;
        const jid = journal('run.compacted', `${id} compacted and resumed`, id, false);
        json(response, 200, ok(jid, `${id} compacted and resumed`, false, lane));
        return;
      }
      const runVerifyMatch = /^\/run\/([^/]+)\/verify$/.exec(urlPath);
      if (runVerifyMatch && method === 'POST') {
        const id = decodeURIComponent(runVerifyMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        lane.state = 'done';
        if (!lane.pr) lane.pr = { no: 900 + db.jn, url: 'https://example.invalid/pr/verify', files: 1, add: 1, del: 0, draft: true };
        const jid = journal('run.verified', `${id} verified`, id, false);
        json(response, 200, ok(jid, `${id} verified`, false, lane));
        return;
      }
      const runRecheckMatch = /^\/run\/([^/]+)\/recheck$/.exec(urlPath);
      if (runRecheckMatch && method === 'POST') {
        const id = decodeURIComponent(runRecheckMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        // A visible sign the click actually re-read something, the stub's own stand-in
        // for the real server's fresh `gh pr view` + drift read: pending checks clear.
        if (lane.pr && lane.pr.checks === 'pending') lane.pr = { ...lane.pr, checks: 'success' };
        json(response, 200, stubSummary(lane, id));
        return;
      }
      const runReauditMatch = /^\/run\/([^/]+)\/reaudit$/.exec(urlPath);
      if (runReauditMatch && method === 'POST') {
        const id = decodeURIComponent(runReauditMatch[1] as string);
        const lane = findLane(id);
        if (!lane || !lane.pr) {
          const body: ReauditResponse = { started: false, reason: `no repo/PR on record for run ${id} to re-audit` };
          json(response, 501, body);
          return;
        }
        const body: ReauditResponse = { started: true };
        json(response, 200, body);
        // The stub's stand-in for a council round actually running: the sheet's own
        // poll (every few seconds) sees the stale flag clear once this fires, the same
        // shape a real attestation landing on disk would produce.
        setTimeout(() => {
          if (db.staleAuditLane === id) db.staleAuditLane = null;
        }, 2_000);
        return;
      }
      const runCapMatch = /^\/run\/([^/]+)\/cap$/.exec(urlPath);
      if (runCapMatch && method === 'POST') {
        const id = decodeURIComponent(runCapMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        const body = await readJson<{ tokenCap?: number }>(request);
        const tokenCap = body.tokenCap ?? 0;
        if (tokenCap > db.caps.hardTokens) { json(response, 422, { error: `above the org hard limit`, hardTokens: db.caps.hardTokens }); return; }
        const previous = lane.tokenCap;
        lane.tokenCap = tokenCap;
        const jid = journal('run.cap.set', `${id} cap set to ${fmtTokens(tokenCap)} tokens`, id, true);
        db.journal[0]!.text += ` (was ${previous === null ? 'unset' : `${fmtTokens(previous)} tokens`})`;
        json(response, 200, ok(jid, `${id} cap set to ${fmtTokens(tokenCap)} tokens`, true, lane));
        return;
      }

      if (urlPath === '/caps' && method === 'POST') {
        const body = await readJson<{ dailyTokens?: number; runTokens?: number; confirm?: string }>(request);
        const gated = gate(body as Record<string, unknown>, `sets the token caps to daily ${body.dailyTokens !== undefined ? fmtTokens(body.dailyTokens) : 'unchanged'}, per run ${body.runTokens !== undefined ? fmtTokens(body.runTokens) : 'unchanged'}.`, () => {
          if ((body.dailyTokens !== undefined && body.dailyTokens > db.caps.hardTokens) || (body.runTokens !== undefined && body.runTokens > db.caps.hardTokens)) {
            return { status: 422, body: { error: 'above the org hard limit', hardTokens: db.caps.hardTokens } };
          }
          db.caps = { ...db.caps, dailyTokens: body.dailyTokens ?? db.caps.dailyTokens, runTokens: body.runTokens ?? db.caps.runTokens };
          journal('caps.set', `caps updated: daily ${fmtTokens(db.caps.dailyTokens)} tokens, per-run ${fmtTokens(db.caps.runTokens)} tokens`, null, true);
          return { status: 200, body: db.caps };
        });
        json(response, gated.status, gated.body);
        return;
      }

      // NeedsYou fix (2026-09-07): `Dismiss` on a stale ask goes through the same
      // `/clear {inboxKey}` path the real server's breaker Clear button already uses --
      // finds the lane still carrying that question and retires it, the stub's own
      // stand-in for `Inbox.retire` + the `inbox.retired` journal event.
      if (urlPath === '/clear' && method === 'POST') {
        const body = await readJson<{ inboxKey?: string; confirm?: string }>(request);
        const key = body.inboxKey;
        if (!key) { json(response, 400, { error: 'a clear needs an inboxKey' }); return; }
        const gated = gate(body as Record<string, unknown>, `dismisses the question ${key}: the ask leaves the inbox and nothing answers it.`, () => {
          const lane = db.lanes.find((l) => l.question?.key === key);
          if (!lane) return { status: 404, body: { error: `nothing asked ${key}` } };
          lane.question = null;
          const jid = journal('inbox.retired', `stale ask retired (${key})`, lane.id, false);
          return { status: 200, body: { ok: true, jid, message: `dismissed ${key}`, undoable: false } };
        });
        json(response, gated.status, gated.body);
        return;
      }

      if (urlPath === '/stop' && method === 'POST') {
        const stopBody = await readJson<Record<string, unknown>>(request);
        const gated = gate(stopBody, 'stops every running lane with a handoff request and engages the kill switch.', () => {
          const running = db.lanes.filter((l) => l.state === 'running');
          for (const l of running) { l.state = 'parked'; l.heart = false; l.tokensPerMin = 0; l.reason = 'stopped from the console'; }
          journal('fleet.stopped', `stopped ${running.length} lanes`, null, false);
          return { status: 200, body: { ok: true, jid: null, message: `stopped ${running.length} lane${running.length === 1 ? '' : 's'}`, undoable: false, stopped: running.map((l) => l.id), stale: [] } };
        });
        json(response, gated.status, gated.body);
        return;
      }
      const runRetireMatch = /^\/run\/([^/]+)\/retire$/.exec(urlPath);
      if (runRetireMatch && method === 'POST') {
        const id = decodeURIComponent(runRetireMatch[1] as string);
        const lane = findLane(id);
        if (!lane) { json(response, 404, { error: `no lane named ${id}` }); return; }
        const retireBody = await readJson<Record<string, unknown>>(request);
        const gated = gate(retireBody, `retires ${id}: the lane leaves the board's default view.`, () => {
          if (lane.state === 'running') return { status: 409, body: { error: `${id} is still running` } };
          lane.retiredAt = Date.now();
          const jid = journal('lane.retired', `${id} retired`, id, false);
          return { status: 200, body: ok(jid, `${id} retired`, false, lane) };
        });
        json(response, gated.status, gated.body);
        return;
      }

      if (urlPath === '/command' && method === 'POST') {
        const body = await readJson<{ text?: string; run?: string }>(request);
        const text = body.text ?? '';
        // The real route echoes the operator's own bubble first (`ConsoleWrites.command`).
        const operator: Message = { k: `op-${Date.now()}-${Math.random()}`, type: 'operator', text, ts: Date.now(), source: 'operator' };
        const cards = [operator, ...runCommand(text, body.run)];
        db.thread = [...db.thread, ...cards];
        json(response, 200, { cards });
        return;
      }

      if (urlPath === '/queue' && method === 'POST') {
        const body = await readJson<QueueAddRequest>(request);
        json(response, 200, addQueueItem(body));
        return;
      }

      const blockerItemMatch = /^\/blockers\/([^/]+)\/(resolve|check)$/.exec(urlPath);
      if (blockerItemMatch && method === 'POST') {
        const id = decodeURIComponent(blockerItemMatch[1] as string);
        const claim = blockerItemMatch[2] === 'resolve';
        json(response, 200, resolveBlockerFixture(id, claim));
        return;
      }
      if (urlPath === '/queue/pause' && method === 'POST') {
        db.queuePaused = true;
        db.queuePauseReason = null;
        json(response, 200, { ok: true, jid: null, message: 'queue paused', undoable: true });
        return;
      }
      if (urlPath === '/queue/resume' && method === 'POST') {
        db.queuePaused = false;
        db.queuePauseReason = null;
        json(response, 200, { ok: true, jid: null, message: 'queue resumed', undoable: false });
        return;
      }
      if (urlPath === '/queue/width' && method === 'POST') {
        const body = await readJson<{ maxInFlight: number }>(request);
        const value = body?.maxInFlight;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 12) {
          json(response, 400, { ok: false, jid: null, message: 'maxInFlight must be an integer between 1 and 12', undoable: false });
          return;
        }
        db.queueMaxInFlight = value;
        json(response, 200, { ok: true, jid: null, message: `queue width set to ${value}`, undoable: false });
        return;
      }
      const queueItemMatch = /^\/queue\/([^/]+)\/(remove|retry|merge|promote)$/.exec(urlPath);
      if (queueItemMatch && method === 'POST') {
        const id = decodeURIComponent(queueItemMatch[1] as string);
        const action = queueItemMatch[2];
        const item = db.queue.find((q) => q.id === id);
        if (action === 'remove') {
          if (!item) { json(response, 404, { ok: false, jid: null, message: `no queue item ${id}`, undoable: false }); return; }
          const removeBody = await readJson<Record<string, unknown>>(request);
          const gated = gate(removeBody, `removes ${id} from the queue: it will not run.`, () => {
            db.queue = db.queue.filter((q) => q.id !== id);
            return { status: 200, body: { ok: true, jid: null, message: `removed ${id}`, undoable: false } };
          });
          json(response, gated.status, gated.body);
          return;
        }
        if (action === 'retry') {
          if (!item || (item.state !== 'parked' && item.state !== 'failed')) {
            json(response, 409, { ok: false, jid: null, message: `${id} is not parked or failed`, undoable: false });
            return;
          }
          item.state = 'queued';
          item.reason = null;
          item.updatedAt = Date.now();
          json(response, 200, { ok: true, jid: null, message: `${id} is queued again`, undoable: false });
          return;
        }
        // A.7: Merge ships a hotfix to dev; Promote is the separate click that puts an
        // already-merged hotfix into production. Neither is reached by `fakeAdvance`;
        // both are always a click.
        if (action === 'merge') {
          if (!item || item.state !== 'review') {
            json(response, 409, { ok: false, jid: null, message: `${id} is not in review`, undoable: false });
            return;
          }
          const mergeItemBody = await readJson<Record<string, unknown>>(request);
          const gated = gate(mergeItemBody, `merges ${id}: merges its pull request and closes the ticket.`, () => {
            item.state = 'done';
            item.updatedAt = Date.now();
            return { status: 200, body: { ok: true, jid: null, message: `${id} merged`, undoable: false } };
          });
          json(response, gated.status, gated.body);
          return;
        }
        if (!item || item.state !== 'done' || item.source !== 'hotfix') {
          json(response, 409, { ok: false, jid: null, message: `${id} is not a merged hotfix`, undoable: false });
          return;
        }
        const promoteBody = await readJson<{ version?: string; message?: string; confirm?: string }>(request);
        if (!promoteBody.version || !promoteBody.message) {
          json(response, 400, { ok: false, jid: null, message: 'a promote needs a version and a message', undoable: false });
          return;
        }
        const version = promoteBody.version;
        const gated = gate(promoteBody as Record<string, unknown>, `publishes ${version} to production for ${id}: every installed app takes the update.`, () => {
          item.updatedAt = Date.now();
          item.promotedAt = Date.now();
          item.promotedVersion = version;
          return { status: 200, body: { ok: true, jid: null, message: `production publish dispatched for ${version}`, undoable: false } };
        });
        json(response, gated.status, gated.body);
        return;
      }

      // `POST /send`: the real server's own run-scoped delivery (`ForgeServer.send`,
      // `RunInbox.send`) -- a card lands on that one run's own thread, tagged with its
      // `lane`, never routed through the free-text command classifier `/command` uses.
      if (urlPath === '/send' && method === 'POST') {
        const body = await readJson<{ run?: string; text?: string }>(request);
        if (!body.run || !body.text) {
          json(response, 400, { error: 'a send needs a run and text' });
          return;
        }
        const now = Date.now();
        db.thread = [...db.thread, {
          k: `send-${now}-${Math.random()}`, type: 'operator', text: body.text, ts: now,
          source: 'operator', lane: body.run,
        }];
        json(response, 200, { ok: true });
        return;
      }

      const checkMatch = /^\/integrations\/([^/]+)\/check$/.exec(urlPath);
      if (checkMatch && method === 'POST') {
        const id = decodeURIComponent(checkMatch[1] as string);
        db.integrations = db.integrations.map((i) => (i.id === id ? { ...i, checkedAt: Date.now() } : i));
        json(response, 200, { items: db.integrations, checkedAt: Date.now(), everyS: 30 });
        return;
      }
      const reconnectMatch = /^\/integrations\/([^/]+)\/reconnect$/.exec(urlPath);
      if (reconnectMatch && method === 'POST') {
        const id = decodeURIComponent(reconnectMatch[1] as string);
        const integration = db.integrations.find((i) => i.id === id);
        if (!integration) { json(response, 404, { error: `no integration named ${id}` }); return; }
        integration.status = 'ok'; integration.since = null; integration.step = 3;
        for (const lane of db.lanes) {
          if (lane.blockedBy === id) { lane.state = 'running'; lane.heart = true; lane.blockedBy = null; }
        }
        const jid = journal('blocker.cleared', `${integration.name} reconnected`, null, false);
        appendEvent(`${integration.name} reconnected`);
        publish({ type: 'blocker.cleared', integration: id });
        json(response, 200, {
          ok: true, integration, steps: [{ text: 'open SSO', done: true }, { text: 'verify', done: true }, { text: 'resume lanes', done: true }],
          message: `${integration.name} reconnected`, jid,
        });
        return;
      }

      const applyMatch = /^\/proposals\/([^/]+)\/apply$/.exec(urlPath);
      if (applyMatch && method === 'POST') {
        const id = decodeURIComponent(applyMatch[1] as string);
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) { json(response, 404, { error: `no proposal named ${id}` }); return; }
        const jid = journal('decision.made', `applied ${rule.title}`, null, true);
        rule.status = 'applied'; rule.jid = jid;
        if (id === 'kill3') {
          const target = db.lanes.find((l) => l.fails >= 2);
          if (target) { target.state = 'killed'; target.heart = false; appendEvent(`${target.id} killed by rule ${rule.title}`, target.id); }
        }
        if (id === 'autoans') {
          const parked = db.lanes.find((l) => l.state === 'parked' && l.question);
          if (parked && parked.question) {
            parked.state = 'running'; parked.heart = true; parked.question = null;
            appendEvent(`${parked.id} auto-answered by rule ${rule.title}`, parked.id);
          }
        }
        json(response, 200, ok(jid, `applied ${rule.title}`, true, undefined));
        return;
      }
      const dismissMatch = /^\/proposals\/([^/]+)\/dismiss$/.exec(urlPath);
      if (dismissMatch && method === 'POST') {
        const id = decodeURIComponent(dismissMatch[1] as string);
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) { json(response, 404, { error: `no proposal named ${id}` }); return; }
        rule.status = 'dismissed';
        const jid = journal('decision.made', `dismissed ${rule.title}`, null, true);
        json(response, 200, ok(jid, `dismissed ${rule.title}`, true));
        return;
      }
      const restoreMatch = /^\/proposals\/([^/]+)\/restore$/.exec(urlPath);
      if (restoreMatch && method === 'POST') {
        const id = decodeURIComponent(restoreMatch[1] as string);
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) { json(response, 404, { error: `no proposal named ${id}` }); return; }
        rule.status = 'open';
        json(response, 200, ok('', `restored ${rule.title}`, false));
        return;
      }

      const undoMatch = /^\/journal\/([^/]+)\/undo$/.exec(urlPath);
      if (undoMatch && method === 'POST') {
        const jid = decodeURIComponent(undoMatch[1] as string);
        const entry = db.journal.find((j) => j.jid === jid);
        if (!entry || !entry.undoable || entry.undone) { json(response, 409, { error: `${jid} cannot be undone` }); return; }
        entry.undone = true;
        if (entry.kind === 'run.paused' && entry.run) {
          const lane = findLane(entry.run);
          if (lane) { lane.state = 'running'; lane.heart = true; }
        }
        json(response, 200, ok(jid, `undone ${jid}`, false));
        return;
      }

      serveStatic(request, response, urlPath);
    })();
  });

  server.on('upgrade', (request, socket) => {
    const duplex = socket as Duplex;
    const urlPath = (request.url ?? '/').split('?')[0];
    const key = request.headers['sec-websocket-key'];
    if (urlPath !== '/events' || typeof key !== 'string') {
      duplex.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    duplex.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
      + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(duplex);
    duplex.on('close', () => sockets.delete(duplex));
    // A page navigation or a Playwright route abort tears this socket down without a
    // clean close; with no listener here Node treats that as an unhandled 'error' and
    // takes the whole stub server down mid-suite (ECONNABORTED, seen 2026-09-05 killing
    // every test after the first WS client left).
    duplex.on('error', () => sockets.delete(duplex));
  });

  const heartbeat = setInterval(() => publish({ type: 'heartbeat', at: Date.now() }), HEARTBEAT_MS);
  server.on('close', () => clearInterval(heartbeat));

  return server;
}

/** Test-only: put the fixtures back to their seed shape between specs. */
export function resetStubDb(): void {
  db = seedDb();
}

function isMainModule(): boolean {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}
const isMain = isMainModule();
if (isMain) {
  const server = createStubServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`forge console stub: http://127.0.0.1:${PORT} (token ${TOKEN})`);
  });
}
