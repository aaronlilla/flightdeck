/**
 * `GET /blockers`, `POST /blockers/:id/resolve`, `POST /blockers/:id/check`.
 *
 * Detection itself (`blockers.ts#detectBlockers`) is pure; this class is what turns a
 * fresh detection pass into the durable view: which blockers were already open, which
 * just cleared on their own, and which lane a confirmed resolution actually restarts.
 * State lives in an append-only `~/.forge/console/blockers.jsonl` (`blockersLedgerPath`),
 * so a reload never forgets what was confirmed -- the same shape `actions-ledger.ts`
 * already uses for the rest of the console's writes.
 *
 * Every kind's confirmation (did the fix actually take) and restart (what resumes once
 * it did) is injected rather than hard-wired here, mirroring `queue-route.ts`'s own
 * `mergeDeps`/`promoteDeps`: a kind with nothing configured answers honestly rather than
 * pretending to have confirmed or restarted anything.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { consoleDir } from './actions-ledger.js';
import { appendOnce } from '../journal.js';
import { blockerFactsFor, detectBlockers, orderChains, type BlockerSnapshot, type DetectionInputs } from './blockers.js';
import { Binder } from './narrate-bind.js';
import type { Narrator } from './narrate-store.js';
import type { Blocker, BlockerKind, BlockersActionResult, BlockersResponse, NarrationBag } from '../../shared/console-model.js';

export function blockersLedgerPath(): string {
  return join(consoleDir(), 'blockers.jsonl');
}

interface LedgerRow {
  type: 'opened' | 'resolve-claim' | 'check' | 'resolved' | 'started';
  id: string;
  at: number;
  ok?: boolean;
  detail?: string;
  lanes?: string[];
  snapshot?: BlockerSnapshot;
}

function readLedger(path: string): LedgerRow[] {
  if (!existsSync(path)) return [];
  const rows: LedgerRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LedgerRow);
    } catch {
      // A half-written line at the tail (a crash mid-append) is skipped, never thrown.
    }
  }
  return rows;
}

function appendLedger(path: string, row: LedgerRow): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
}

export interface Confirmation {
  ok: boolean;
  detail: string;
}

/** Runs a blocker's confirmation: did the fix actually take. */
export type Confirmer = (blocker: Blocker) => Promise<Confirmation>;

/** Resumes whatever a cleared blocker's chain was holding back, returning the lanes it
 *  actually started (already-running lanes are the restarter's own no-op, never this
 *  route's job to dedupe). */
export type Restarter = (blocker: Blocker, laneIds: string[]) => Promise<string[]>;

export interface BlockersRoutesOptions {
  /** Absent (a specimen, or `FORGE_NARRATE=off`) means every card serves its own
   *  template in all three registers -- never a blank card and never a model call. */
  narrator?: Narrator | null;
  ledgerPath?: string;
  journalPath: string;
  authorized: (request: IncomingMessage, response: ServerResponse) => boolean;
  /** Gathers live detection inputs from the inbox, the integrations registry, the lane
   *  view and an injected `gh` reader. Async because a `gh` read is. */
  gather: () => Promise<DetectionInputs>;
  confirmers: Partial<Record<BlockerKind, Confirmer>>;
  restarters: Partial<Record<BlockerKind, Restarter>>;
}

const ITEM_ROUTE = /^\/blockers\/([^/]+)\/(resolve|check)$/;
const RESOLVED_WINDOW_MS = 24 * 60 * 60_000;

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

export class BlockersRoutes {
  constructor(private readonly opts: BlockersRoutesOptions) {}

  static matches(path: string, method: string | undefined): boolean {
    if (path === '/blockers') return method === 'GET';
    return ITEM_ROUTE.test(path) && method === 'POST';
  }

  private ledgerPath(): string {
    return this.opts.ledgerPath ?? blockersLedgerPath();
  }

  /** The whole state fold: this poll's live detection, reconciled against what the
   *  ledger already knows was open, with `opened`/`resolved` transitions written for
   *  whatever changed since the last read. Never writes on a poll that finds nothing
   *  new -- only a real transition grows the file. */
  private reconcile(live: BlockerSnapshot[], now: number): { open: Blocker[]; resolvedToday: Blocker[] } {
    const path = this.ledgerPath();
    const rows = readLedger(path);
    const liveIds = new Set(live.map((b) => b.id));
    const liveById = new Map(live.map((b) => [b.id, b]));

    const lastOpenSnapshot = new Map<string, BlockerSnapshot>();
    const lastEventById = new Map<string, LedgerRow>();
    for (const row of rows) {
      if (row.type === 'opened') { lastEventById.set(row.id, row); if (row.snapshot) lastOpenSnapshot.set(row.id, row.snapshot); }
      if (row.type === 'resolved') lastEventById.set(row.id, row);
    }
    const knownOpenIds = new Set(
      [...lastEventById.entries()].filter(([, row]) => row.type === 'opened').map(([id]) => id),
    );

    for (const b of live) {
      if (!knownOpenIds.has(b.id)) appendLedger(path, { type: 'opened', id: b.id, at: now, snapshot: b });
    }
    for (const id of knownOpenIds) {
      if (!liveIds.has(id)) {
        appendLedger(path, { type: 'resolved', id, at: now, detail: 'the cause cleared on its own' });
      }
    }

    const rows2 = readLedger(path);
    const checkedAtById = new Map<string, number>();
    const lastCheckById = new Map<string, string>();
    const resolvedRows: LedgerRow[] = [];
    const openedSnapshotById = new Map<string, BlockerSnapshot>();
    for (const row of rows2) {
      if (row.type === 'opened' && row.snapshot) openedSnapshotById.set(row.id, row.snapshot);
      if (row.type === 'check' || row.type === 'resolved') {
        checkedAtById.set(row.id, row.at);
        if (row.detail) lastCheckById.set(row.id, row.detail);
      }
      if (row.type === 'resolved') resolvedRows.push(row);
    }

    const open: Blocker[] = live.map((b) => ({
      ...b,
      state: 'open',
      checkedAt: checkedAtById.get(b.id) ?? null,
      resolvedAt: null,
      lastCheck: lastCheckById.get(b.id) ?? null,
    }));

    const resolvedToday: Blocker[] = [];
    const seenResolved = new Set<string>();
    for (const row of [...resolvedRows].reverse()) {
      if (seenResolved.has(row.id) || liveById.has(row.id) || now - row.at > RESOLVED_WINDOW_MS) continue;
      seenResolved.add(row.id);
      const snapshot = openedSnapshotById.get(row.id) ?? lastOpenSnapshot.get(row.id);
      if (!snapshot) continue;
      resolvedToday.push({
        ...snapshot, state: 'resolved', checkedAt: row.at, resolvedAt: row.at, lastCheck: row.detail ?? 'resolved',
      });
    }

    return { open, resolvedToday };
  }

  async list(): Promise<BlockersResponse> {
    const inputs = await this.opts.gather();
    const live = detectBlockers(inputs);
    const { open, resolvedToday } = this.reconcile(live, inputs.now);
    const blockers = [...open, ...resolvedToday].map((b) => this.narrate(b));
    return { blockers, chains: orderChains(open) };
  }

  /**
   * The three registers for one blocker card.
   *
   * `question` is the one kind whose title and detail are a person's own words -- the
   * operator typed the question into the run and the card is quoting it back. Those go
   * through `Binder.verbatim`, which cannot reach the model and writes no cache key, so
   * the guardrail is structural rather than a rule someone has to remember. Everything
   * else on the card (how to resolve it, what happens next, the note under the owner's
   * name) is a sentence this repo wrote about its own state, and is narrated.
   */
  private narrate(blocker: Blocker): Blocker {
    const bag: NarrationBag = {};
    const binder = new Binder(this.opts.narrator ?? null, 'blockers');
    const out: Blocker = { ...blocker };

    if (blocker.kind === 'question') {
      binder.verbatim(bag, 'title', blocker.title);
      binder.verbatim(bag, 'detail', blocker.detail);
    } else {
      const title = binder.field(bag, 'title', blockerFactsFor(blocker, 'blocker.title', blocker.title), blocker.id);
      if (title !== null) out.title = title;
      const detail = binder.field(bag, 'detail', blockerFactsFor(blocker, 'blocker.detail', blocker.detail), blocker.id);
      if (detail !== null) out.detail = detail;
    }

    const how = binder.field(bag, 'howToResolve', blockerFactsFor(blocker, 'blocker.howToResolve', blocker.howToResolve), blocker.id);
    if (how !== null) out.howToResolve = how;
    const then = binder.field(bag, 'thenWhat', blockerFactsFor(blocker, 'blocker.thenWhat', blocker.thenWhat), blocker.id);
    if (then !== null) out.thenWhat = then;
    if (blocker.whoNote) {
      const note = binder.field(bag, 'whoNote', blockerFactsFor(blocker, 'blocker.whoNote', blocker.whoNote), blocker.id);
      if (note !== null) out.whoNote = note;
    }

    if (Object.keys(bag).length > 0) out.narration = bag;
    return out;
  }

  /** `POST /blockers/:id/resolve`: a person says "I did it". Moves the blocker to
   *  `checking`, runs its confirmation, and -- on success -- restarts whatever chain
   *  just cleared. */
  async resolve(id: string): Promise<BlockersActionResult> {
    return this.confirmAndMaybeRestart(id, true);
  }

  /** `POST /blockers/:id/check`: re-runs the confirmation without claiming resolution
   *  (never restarts anything on its own -- only a claimed resolve does). */
  async check(id: string): Promise<BlockersActionResult> {
    return this.confirmAndMaybeRestart(id, false);
  }

  /** `POST /blockers/:id/check` and, on success, `/resolve`'s own confirmation step:
   *  runs the kind's injected `Confirmer`, journals the outcome, and (resolve only)
   *  restarts whatever chain just cleared. */
  private async confirmAndMaybeRestart(id: string, claim: boolean): Promise<BlockersActionResult> {
    const path = this.ledgerPath();
    const result = await this.list();
    const blocker = result.blockers.find((b) => b.id === id);
    if (!blocker) return { ok: false, state: 'open', lastCheck: 'no such blocker', started: [] };
    if (blocker.state === 'resolved') {
      return { ok: true, state: 'resolved', lastCheck: blocker.lastCheck, started: [] };
    }
    if (claim && !blocker.youCanResolve) {
      return { ok: false, state: 'open', lastCheck: 'nothing to click here -- nudge the owner instead', started: [] };
    }
    if (claim) appendLedger(path, { type: 'resolve-claim', id, at: Date.now() });

    const confirmer = this.opts.confirmers[blocker.kind];
    if (!confirmer) {
      const detail = `no confirmation is wired for ${blocker.kind} yet`;
      appendLedger(path, { type: 'check', id, at: Date.now(), ok: false, detail });
      return { ok: false, state: 'open', lastCheck: detail, started: [] };
    }

    const outcome = await confirmer(blocker);
    appendLedger(path, { type: 'check', id, at: Date.now(), ok: outcome.ok, detail: outcome.detail });
    if (!outcome.ok) {
      return { ok: false, state: 'open', lastCheck: outcome.detail, started: [] };
    }
    appendLedger(path, { type: 'resolved', id, at: Date.now(), detail: outcome.detail });
    appendOnce(this.opts.journalPath, { event: 'blocker.cleared', actor: 'console', reason: id, lanes: blocker.blocks.map((b) => b.laneId) });

    // A plain `/check` (never a claim) confirms without restarting -- restarting is
    // what an actual "I did it" earns, not a re-run someone clicked out of curiosity.
    const started = claim ? await this.restartClearedChain(blocker) : [];
    if (started.length) {
      appendLedger(path, { type: 'started', id, at: Date.now(), lanes: started });
    }
    return { ok: true, state: 'resolved', lastCheck: outcome.detail, started };
  }

  /** Once `blocker` clears, every lane it names in `blocks` restarts if -- and only if
   *  -- a fresh detection pass shows nothing else in that lane's chain is still open.
   *  Never restarts a lane twice: `restarters` are handed the exact lane ids to act on
   *  and are themselves the ones that no-op on an already-running lane. */
  private async restartClearedChain(blocker: Blocker): Promise<string[]> {
    const restarter = this.opts.restarters[blocker.kind];
    if (!restarter || blocker.blocks.length === 0) return [];
    const fresh = await this.list();
    const stillBlocked = new Set(fresh.blockers.filter((b) => b.state === 'open').flatMap((b) => b.blocks.map((x) => x.laneId)));
    const clearLanes = blocker.blocks.map((b) => b.laneId).filter((laneId) => !stillBlocked.has(laneId));
    if (clearLanes.length === 0) return [];
    return restarter(blocker, clearLanes);
  }

  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!BlockersRoutes.matches(path, request.method)) return false;
    if (!this.opts.authorized(request, response)) return true;

    if (path === '/blockers' && request.method === 'GET') {
      respond(response, 200, await this.list());
      return true;
    }

    const match = ITEM_ROUTE.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const action = match[2]!;
      const result = action === 'resolve' ? await this.resolve(id) : await this.check(id);
      // Always 200: `result.ok` carries the outcome, and `lastCheck` is the actual
      // reason a "not yet" reads the way it does -- a 4xx here would make the
      // console's own `redactErrorBody` throw that detail away (it only reads an
      // `{error}` body), and "Not yet: <lastCheck>" needs the real sentence.
      respond(response, 200, result);
      return true;
    }

    return false;
  }
}
