/**
 * The intake queue's own routes: `GET /queue`, `POST /queue` (the four-source add),
 * `POST /queue/:id/remove`, `POST /queue/:id/retry`, `POST /queue/pause`,
 * `POST /queue/resume`. One class, mirroring the shape `ConsoleReads`/`ConsoleWrites`
 * already use, wired into `server.ts#route()` the same way `/router` is: a dedicated
 * `matches`/`handle` pair the caller checks before falling through to its own 404.
 *
 * Every write here is a queue mutation only -- adding, removing, retrying, pausing. The
 * worker that actually moves an item forward (`runQueueTick`) is `forge up`'s own timer;
 * this class never calls it, and never spawns anything itself.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import {
  addBacklogItems, addBriefItem, addGoalItem, addHotfixItem, addQueryItems, addTicketItem, mergeItem, promoteItem,
  removeItem, retryItem, type QueueMergeDeps, type QueuePromoteDeps, type QueueTicketSearch,
} from '../intake/queue.js';
import { resolveGoalBlock } from '../intake/goalFile.js';
import { buildBacklogJql as defaultBuildBacklogJql, readQueueWidth, writeQueueWidth } from '../queue-wire.js';
import { queueTitleFor } from './queue-title.js';
import type { QueueStore } from '../intake/queueStore.js';
import type {
  ActionResult, QueueAddRequest, QueueAddResponse, QueueItem, QueueResponse, QueueSource,
} from '../../shared/console-model.js';

const QUEUE_SOURCES: readonly QueueSource[] = ['ticket', 'brief', 'query', 'backlog', 'hotfix', 'goal'];

const ITEM_ROUTE = /^\/queue\/([^/]+)\/(remove|retry|merge|promote)$/;

export interface QueueRoutesOptions {
  store: QueueStore;
  search: QueueTicketSearch;
  /** A.7: the Merge click's own dependencies. Absent means `/queue/:id/merge` refuses
   *  outright -- never a silent no-op, and never a default that merges anything. */
  mergeDeps?: QueueMergeDeps;
  /** A.7: the Promote click's own dependencies. Absent means `/queue/:id/promote`
   *  501s, the same honest refusal `promoteItem` itself gives when the production
   *  workflow isn't wired -- this route never guesses at a production dispatch. */
  promoteDeps?: QueuePromoteDeps;
  authorized: (request: IncomingMessage, response: ServerResponse) => boolean;
  readPaused: () => boolean;
  writePaused: (paused: boolean) => void;
  /** No longer read anywhere in this class -- `response()` calls `readQueueWidth()`
   *  straight from `queue-wire.ts` instead, so `GET /queue` reflects a `POST
   *  /queue/width` on its very next call. Kept only so an existing caller's options
   *  object still typechecks. */
  maxInFlight: number;
  /** `POST /queue/width`'s one required side effect (queue-throughput W2): every
   *  successful width change publishes once, of kind `queue`, the same channel every
   *  other console write already uses. Absent means the write still lands on disk but
   *  no listener hears about it -- a caller with no publish channel wired, same honest
   *  gap `mergeDeps`/`promoteDeps` leave when absent above. */
  publish?: (event: Record<string, unknown>) => void;
  /** A.5: wraps an operator's own backlog filter text into a project-scoped JQL before
   *  it reaches `search`. Defaults to the queue's own production wrapper
   *  (`queue-wire.ts#buildBacklogJql`, `FORGE_BACKLOG_PROJECT`), so this route works
   *  unwired; a test injects its own to stay a pure specimen. */
  buildBacklogJql?: (filter: string) => string;
  /** The server-side confirm every irreversible queue click (remove, merge, promote)
   *  runs behind: `ConsoleWrites.confirmGate`, so a typed `confirm <token>` in the
   *  rail resolves the same pending entry the click created. Absent (a bare specimen),
   *  the action runs at once. */
  confirmGate?: ConfirmGate;
}

export type ConfirmGate = (
  body: Record<string, unknown> | null | undefined, source: string, blast: string,
  act: () => Promise<{ status: number; body: unknown }>,
) => Promise<{ status: number; body: unknown }>;

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text),
  });
  response.end(text);
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

/** A Jira key: a project prefix, a dash, a number. Anything else never reaches Jira as
 *  a query, which is how a pasted file path used to come back as a JQL 400. */
const TICKET_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** The brief source takes pasted text or, when the whole input is one line naming an
 *  existing `.md` file on this machine, that file's contents. */
function briefTextFrom(input: string): string {
  const line = input.trim();
  if (line.includes('\n') || !/\.md$/i.test(line) || !existsSync(line)) return input;
  if (!statSync(line).isFile()) return input;
  return readFileSync(line, 'utf8');
}

/** How a source names where an item came from, for the Queue view's "why it is next". */
const SOURCE_WORDS: Record<QueueSource, string> = {
  ticket: 'a ticket in Ready for Dev',
  brief: 'a pasted brief',
  query: 'a Jira query',
  backlog: 'the backlog filter',
  hotfix: 'a typed hotfix',
  goal: 'a goal file',
};

/**
 * The Queue view's two sentences for a queued item (`Flightdeck Console.dc.html` 1c):
 * why it sits where it does, and when it starts. Both come from the queue's own facts:
 * position in the order, the source it was added from, its `after:` lines, the width
 * and what is in flight, and whether the queue is paused. Items already past `queued`
 * get neither.
 */
export function queueOrderWords(
  item: QueueItem, all: QueueItem[], queue: { paused: boolean; maxInFlight: number; inFlight: number },
): { whyNext?: string; startsIn?: string } {
  if (item.state !== 'queued') return {};
  const queued = all.filter((row) => row.state === 'queued');
  const position = queued.findIndex((row) => row.id === item.id);
  const ordinal = position === 0 ? 'First' : position === 1 ? 'Second' : position === 2 ? 'Third' : `${position + 1}th`;
  const waitsFor = (item.after ?? []).filter((slug) => !all.some((row) => row.state === 'done' && (row.input === slug || row.branch === `feature/${slug}`)));
  const why = waitsFor.length > 0
    ? `${ordinal} in the queue, from ${SOURCE_WORDS[item.source]}. Its brief says to wait for ${waitsFor.join(', ')}.`
    : `${ordinal} in the queue, from ${SOURCE_WORDS[item.source]}; queued ${new Date(item.createdAt).toISOString().slice(11, 16)} UTC.`;
  let starts: string;
  if (queue.paused) starts = 'When the queue resumes';
  else if (waitsFor.length > 0) starts = `After ${waitsFor.join(', ')} finishes`;
  else {
    const free = Math.max(0, queue.maxInFlight - queue.inFlight);
    const ahead = queued.slice(0, position).filter((row) => !(row.after && row.after.length > 0)).length;
    starts = ahead < free ? 'Takes a free slot on the next tick' : ahead === free ? 'When the next slot frees' : `After ${ahead - free + 1} more finish`;
  }
  return { whyNext: why, startsIn: starts };
}

export class QueueRoutes {
  constructor(private readonly opts: QueueRoutesOptions) {}

  static matches(path: string, method: string | undefined): boolean {
    if (path === '/queue') return method === 'GET' || method === 'POST';
    if (path === '/queue/pause' || path === '/queue/resume' || path === '/queue/width') return method === 'POST';
    return ITEM_ROUTE.test(path) && method === 'POST';
  }

  /** The Conductor agent's four `queue_*` tools (2026-09-08) read and write through
   *  these, the same code the routes below run, without the HTTP layer. */
  list(): QueueResponse {
    return this.response();
  }

  addItems(body: QueueAddRequest): Promise<QueueAddResponse> {
    return this.add(body);
  }

  remove(id: string): ActionResult {
    const removed = removeItem(this.opts.store, id);
    return removed
      ? { ok: true, jid: null, message: `removed ${id}`, undoable: false }
      : { ok: false, jid: null, message: `no queue item ${id}`, undoable: false };
  }

  retry(id: string): ActionResult {
    const retried = retryItem(this.opts.store, id);
    return retried
      ? { ok: true, jid: null, message: `${id} is queued again`, undoable: false }
      : { ok: false, jid: null, message: `${id} is not parked or failed`, undoable: false };
  }

  private response(): QueueResponse {
    // `title`, `whyNext` and `startsIn` are filled here, on the way out, rather than
    // stored on the item: every item already on disk gets them on the next read, and a
    // brief edited under a queued item retitles itself with no write.
    const items = this.opts.store.all();
    const paused = this.opts.readPaused();
    const maxInFlight = readQueueWidth();
    const inFlight = items.filter((item) => item.state === 'planning' || item.state === 'running').length;
    return {
      items: items.map((item) => ({ ...item, title: queueTitleFor(item), ...queueOrderWords(item, items, { paused, maxInFlight, inFlight }) })),
      paused, maxInFlight,
    };
  }

  /** `POST /queue`: the one route all four sources share. `ticket`/`brief` never touch
   *  the network and cannot fail this way; `query`/`backlog` resolve through Jira and, per
   *  requirement 2, report a missing credential by name rather than adding nothing and
   *  saying nothing. */
  private async add(body: QueueAddRequest | null): Promise<QueueAddResponse> {
    if (!body || !QUEUE_SOURCES.includes(body.source) || !body.input || !body.input.trim()) {
      return { ok: false, items: [], error: 'a queue add needs a source (ticket, brief, query, backlog) and input' };
    }
    try {
      switch (body.source) {
        case 'ticket': {
          const key = body.input.trim();
          if (!TICKET_KEY.test(key)) {
            return {
              ok: false, items: [],
              error: `"${key.slice(0, 60)}" is not a ticket key like ABC-123. For a brief file or pasted text, pick the brief source.`,
            };
          }
          return { ok: true, items: [addTicketItem(this.opts.store, key)] };
        }
        case 'brief': {
          const selfRepo = (process.env['FORGE_SELF_REPO'] ?? '').trim();
          let roadmapText = '';
          if (selfRepo) {
            try {
              roadmapText = readFileSync(resolve(process.cwd(), 'doctrine/ROADMAP.md'), 'utf8');
            } catch {
              roadmapText = '';
            }
          }
          return {
            ok: true,
            items: [addBriefItem(
              this.opts.store, briefTextFrom(body.input), undefined,
              selfRepo ? { selfRepo, roadmapText } : undefined,
            )],
          };
        }
        case 'hotfix':
          return { ok: true, items: [addHotfixItem(this.opts.store, body.input)] };
        case 'goal': {
          const goalPath = resolve(process.cwd(), body.input.trim());
          try {
            const resolved = resolveGoalBlock(goalPath);
            return { ok: true, items: [addGoalItem(this.opts.store, goalPath, resolved.block)] };
          } catch (error) {
            return { ok: false, items: [], error: error instanceof Error ? error.message : String(error) };
          }
        }
        case 'query':
          return { ok: true, items: await addQueryItems(this.opts.store, body.input, this.opts.search) };
        case 'backlog': {
          const buildJql = this.opts.buildBacklogJql ?? defaultBuildBacklogJql;
          return { ok: true, items: await addBacklogItems(this.opts.store, buildJql(body.input), this.opts.search) };
        }
        default:
          return { ok: false, items: [], error: `unknown source ${String(body.source)}` };
      }
    } catch (error) {
      return { ok: false, items: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!QueueRoutes.matches(path, request.method)) return false;
    if (!this.opts.authorized(request, response)) return true;

    if (path === '/queue' && request.method === 'GET') {
      respond(response, 200, this.response());
      return true;
    }

    if (path === '/queue' && request.method === 'POST') {
      const body = await readBody<QueueAddRequest>(request);
      respond(response, 200, await this.add(body));
      return true;
    }

    if (path === '/queue/pause' && request.method === 'POST') {
      this.opts.writePaused(true);
      const result: ActionResult = { ok: true, jid: null, message: 'queue paused', undoable: true };
      respond(response, 200, result);
      return true;
    }

    if (path === '/queue/resume' && request.method === 'POST') {
      this.opts.writePaused(false);
      const result: ActionResult = { ok: true, jid: null, message: 'queue resumed', undoable: false };
      respond(response, 200, result);
      return true;
    }

    if (path === '/queue/width' && request.method === 'POST') {
      const body = await readBody<{ maxInFlight: number }>(request);
      const value = body?.maxInFlight;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 12) {
        respond(response, 400, {
          ok: false, jid: null, message: 'maxInFlight must be an integer between 1 and 12', undoable: false,
        });
        return true;
      }
      writeQueueWidth(value);
      this.opts.publish?.({ kind: 'queue', event: 'queue.width', maxInFlight: value, at: Date.now() });
      const result: ActionResult = { ok: true, jid: null, message: `queue width set to ${value}`, undoable: false };
      respond(response, 200, result);
      return true;
    }

    const match = ITEM_ROUTE.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const action = match[2]!;
      const gate: ConfirmGate = this.opts.confirmGate ?? ((_body, _source, _blast, act) => act());

      if (action === 'remove') {
        // Removing a queued item is irreversible, so the route answers 202 with a
        // token and runs nothing until it comes back. `remove` itself is the method
        // the Conductor's own tool calls, so both paths do exactly one thing.
        const body = await readBody<Record<string, unknown>>(request);
        const outcome = await gate(body, 'console', `removes ${id} from the queue: it will not run.`, async () => {
          const result = this.remove(id);
          return { status: result.ok ? 200 : 404, body: result };
        });
        respond(response, outcome.status, outcome.body);
        return true;
      }

      if (action === 'retry') {
        const result = this.retry(id);
        respond(response, result.ok ? 200 : 409, result);
        return true;
      }

      // A.7: Merge and Promote are always a click -- neither one is reached by anything
      // this file's own worker does on its own.
      if (action === 'merge') {
        const item = this.opts.store.get(id);
        if (!item) {
          respond(response, 404, { ok: false, jid: null, message: `no queue item ${id}`, undoable: false });
          return true;
        }
        if (!this.opts.mergeDeps) {
          respond(response, 501, { ok: false, jid: null, message: 'no merge wiring is configured for this environment', undoable: false });
          return true;
        }
        const mergeDeps = this.opts.mergeDeps;
        const body = await readBody<Record<string, unknown>>(request);
        const gated = await gate(body, 'console', `merges ${id}: merges its pull request and closes the ticket.`, async () => {
          const outcome = await mergeItem(item, mergeDeps);
          const result: ActionResult = { ok: outcome.ok, jid: null, message: outcome.message, undoable: false };
          return { status: outcome.ok ? 200 : 409, body: result };
        });
        respond(response, gated.status, gated.body);
        return true;
      }

      // promote
      const item = this.opts.store.get(id);
      if (!item) {
        respond(response, 404, { ok: false, jid: null, message: `no queue item ${id}`, undoable: false });
        return true;
      }
      const body = await readBody<{ version: string; message: string; confirm?: string }>(request);
      if (!this.opts.promoteDeps) {
        respond(response, 501, { ok: false, jid: null, message: 'no production publish wiring is configured for this environment', undoable: false });
        return true;
      }
      if (!body?.version || !body.message) {
        respond(response, 400, { ok: false, jid: null, message: 'a promote needs a version and a message', undoable: false });
        return true;
      }
      const promoteDeps = this.opts.promoteDeps;
      const gated = await gate(body as Record<string, unknown>, 'console',
        `publishes ${body.version} to production for ${id}: every installed app takes the update.`, async () => {
          const outcome = await promoteItem(item, { version: body.version, message: body.message }, promoteDeps);
          if (outcome.ok) {
            this.opts.store.append({ id, at: Date.now(), promotedAt: Date.now(), promotedVersion: body.version, updatedAt: Date.now() });
          }
          const result: ActionResult = { ok: outcome.ok, jid: null, message: outcome.message, undoable: false };
          return { status: outcome.code, body: result };
        });
      respond(response, gated.status, gated.body);
      return true;
    }

    return false;
  }
}
