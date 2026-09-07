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
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  addBacklogItems, addBriefItem, addQueryItems, addTicketItem, removeItem, retryItem,
  type QueueTicketSearch,
} from '../intake/queue.js';
import { buildBacklogJql as defaultBuildBacklogJql } from '../queue-wire.js';
import type { QueueStore } from '../intake/queueStore.js';
import type {
  ActionResult, QueueAddRequest, QueueAddResponse, QueueResponse, QueueSource,
} from '../../shared/console-model.js';

const QUEUE_SOURCES: readonly QueueSource[] = ['ticket', 'brief', 'query', 'backlog'];

const ITEM_ROUTE = /^\/queue\/([^/]+)\/(remove|retry)$/;

export interface QueueRoutesOptions {
  store: QueueStore;
  search: QueueTicketSearch;
  authorized: (request: IncomingMessage, response: ServerResponse) => boolean;
  readPaused: () => boolean;
  writePaused: (paused: boolean) => void;
  maxInFlight: number;
  /** A.5: wraps an operator's own backlog filter text into a project-scoped JQL before
   *  it reaches `search`. Defaults to the queue's own production wrapper
   *  (`queue-wire.ts#buildBacklogJql`, `FORGE_BACKLOG_PROJECT`), so this route works
   *  unwired; a test injects its own to stay a pure specimen. */
  buildBacklogJql?: (filter: string) => string;
}

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

export class QueueRoutes {
  constructor(private readonly opts: QueueRoutesOptions) {}

  static matches(path: string, method: string | undefined): boolean {
    if (path === '/queue') return method === 'GET' || method === 'POST';
    if (path === '/queue/pause' || path === '/queue/resume') return method === 'POST';
    return ITEM_ROUTE.test(path) && method === 'POST';
  }

  private response(): QueueResponse {
    return {
      items: this.opts.store.all(), paused: this.opts.readPaused(), maxInFlight: this.opts.maxInFlight,
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
        case 'ticket':
          return { ok: true, items: [addTicketItem(this.opts.store, body.input.trim())] };
        case 'brief':
          return { ok: true, items: [addBriefItem(this.opts.store, body.input)] };
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

    const match = ITEM_ROUTE.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const action = match[2]!;
      if (action === 'remove') {
        const removed = removeItem(this.opts.store, id);
        const result: ActionResult = removed
          ? { ok: true, jid: null, message: `removed ${id}`, undoable: false }
          : { ok: false, jid: null, message: `no queue item ${id}`, undoable: false };
        respond(response, removed ? 200 : 404, result);
        return true;
      }
      // retry
      const retried = retryItem(this.opts.store, id);
      const result: ActionResult = retried
        ? { ok: true, jid: null, message: `${id} is queued again`, undoable: false }
        : { ok: false, jid: null, message: `${id} is not parked or failed`, undoable: false };
      respond(response, retried ? 200 : 409, result);
      return true;
    }

    return false;
  }
}
