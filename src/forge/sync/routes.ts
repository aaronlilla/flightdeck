/**
 * R-68 item 6: `GET /sync`, `POST /sync/full`, `POST /sync/:scope`, `POST /watcher/on|off`
 * -- the board's one action and the watcher's runtime switch. Mirrors the shape
 * `QueueRoutes` already uses: a dedicated `matches`/`handle` pair `server.ts#route()`
 * checks before its own 404, and `POST /sync/full` reuses `ConsoleWrites.confirmGate`
 * exactly like an irreversible queue click does.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { SyncScope } from '../../shared/sync-contract.js';
import type { SyncRunner } from './run.js';
import type { SyncStore } from './store.js';
import type { JiraWatcher, WatcherFileState } from './watcher-state.js';

const SYNC_SCOPES = new Set<SyncScope>(['full', 'queue', 'sessions', 'accounts', 'machine', 'inbox', 'lanes']);

const SCOPE_ROUTE = /^\/sync\/([^/]+)$/;

/** Same shape as `console/queue-route.ts#ConfirmGate` -- duplicated rather than imported
 *  so this file never reaches into `console/` for a type. */
export type ConfirmGate = (
  body: Record<string, unknown> | null | undefined, source: string, blast: string,
  act: () => Promise<{ status: number; body: unknown }>,
) => Promise<{ status: number; body: unknown }>;

export interface SyncRoutesOptions {
  runner: SyncRunner;
  store: SyncStore;
  watcher: JiraWatcher;
  authorized: (request: IncomingMessage, response: ServerResponse) => boolean;
  /** Absent means `POST /sync/full` runs at once, the same bare-specimen default every
   *  other confirm-gated route here uses. */
  confirmGate?: ConfirmGate;
  writeWatcherState?: (state: WatcherFileState) => void;
  defaultProject?: () => string | null;
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

export class SyncRoutes {
  constructor(private readonly opts: SyncRoutesOptions) {}

  static matches(path: string, method: string | undefined): boolean {
    if (path === '/sync') return method === 'GET';
    if (SCOPE_ROUTE.test(path)) return method === 'POST';
    if (path === '/watcher/on' || path === '/watcher/off') return method === 'POST';
    return false;
  }

  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!SyncRoutes.matches(path, request.method)) return false;
    if (!this.opts.authorized(request, response)) return true;

    if (path === '/sync' && request.method === 'GET') {
      respond(response, 200, { runs: this.opts.store.all(), watcher: this.opts.watcher.status() });
      return true;
    }

    const scopeMatch = SCOPE_ROUTE.exec(path);
    if (scopeMatch) {
      const scope = decodeURIComponent(scopeMatch[1]!) as SyncScope;
      if (!SYNC_SCOPES.has(scope)) {
        respond(response, 404, { error: `unknown sync scope "${scope}"` });
        return true;
      }
      if (this.opts.runner.isRunning(scope)) {
        respond(response, 409, { reason: 'running' });
        return true;
      }

      const body = await readBody<Record<string, unknown>>(request);
      const start = async (): Promise<{ status: number; body: unknown }> => {
        if (this.opts.runner.isRunning(scope)) return { status: 409, body: { reason: 'running' } };
        try {
          const record = await this.opts.runner.runSync(scope);
          return { status: 202, body: { started: true, id: record.id } };
        } catch (error) {
          return { status: 409, body: { reason: error instanceof Error ? error.message : String(error) } };
        }
      };

      if (scope === 'full') {
        const gate = this.opts.confirmGate ?? ((_body, _source, _blast, act) => act());
        const outcome = await gate(
          body, 'console',
          'wipes the intake queue, stops every running worker, resets every source watermark, '
            + 're-syncs code and worktrees, and pulls Jira -- the full re-sync.',
          start,
        );
        respond(response, outcome.status, outcome.body);
        return true;
      }

      const outcome = await start();
      respond(response, outcome.status, outcome.body);
      return true;
    }

    if (path === '/watcher/on' && request.method === 'POST') {
      const body = await readBody<{ project?: string }>(request);
      const project = body?.project ?? this.opts.watcher.status().project ?? this.opts.defaultProject?.() ?? null;
      if (!project) {
        respond(response, 400, { error: 'a project is required: pass { project } or set FORGE_BACKLOG_PROJECT' });
        return true;
      }
      await this.opts.watcher.start(project);
      this.opts.writeWatcherState?.({ on: true, project });
      respond(response, 200, this.opts.watcher.status());
      return true;
    }

    if (path === '/watcher/off' && request.method === 'POST') {
      const project = this.opts.watcher.status().project;
      this.opts.watcher.stop();
      this.opts.writeWatcherState?.({ on: false, project });
      respond(response, 200, this.opts.watcher.status());
      return true;
    }

    return false;
  }
}
