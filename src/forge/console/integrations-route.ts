/**
 * `POST /integrations/:id/connect` and `GET /integrations/:id/connect/:attempt` -- the
 * one Connect action the console has never had. A new sibling class to `QueueRoutes`/
 * `BlockersRoutes`, wired into `server.ts` directly, per the goal's Program update:
 * M owns all of `src/forge/console/integrations.ts`, and these two routes never touch
 * `command.ts`.
 *
 * The login link an `mcp-login` attempt prints to stdout is the one thing this module
 * exists to keep private: it lives only in the in-memory `AttemptRecord` below, is
 * handed to `GET .../connect/:attempt` exactly once (the first read that finds it
 * present), and is never passed to `IntegrationsRegistry.applyConnectResult`, never
 * journaled, never published. There is no code path from `record.link` to any of those
 * sinks -- the registry update below carries only `mcpState`/`lastError`/`status`.
 */
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { fleetConfigDir, workspaceRoot } from '../paths.js';
import { awsSsoLoginArgv, type IntegrationsRegistry } from './integrations.js';
import type { McpConnState } from '../../shared/console-model.js';
import { sliceEvent } from '../../shared/console-events.js';

const CONNECT_ROUTE = /^\/integrations\/([^/]+)\/connect$/;
const ATTEMPT_ROUTE = /^\/integrations\/([^/]+)\/connect\/([^/]+)$/;

const DEFAULT_TIMEOUT_MS = 300_000;

export type ConnectKind = 'mcp-login' | 'aws-sso' | 'daemon-start' | 'stdio-probe';

export interface ConnectRunner {
  kind: ConnectKind;
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Overridable for a fast test; production leaves this at the default 300s. */
  timeoutMs?: number;
}

export interface ConnectAttemptView {
  state: 'connecting' | McpConnState;
  link?: string;
  error?: string;
}

interface AttemptRecord {
  integrationId: string;
  kind: ConnectKind;
  state: 'connecting' | McpConnState;
  link: string | null;
  linkRead: boolean;
  error: string | null;
}

/** `id.startsWith('mcp-')` recovers the server name `mcpProbes()` built it from
 *  (`integrations.ts`: `` `mcp-${name}` ``). `id === 'aws'` reuses the existing AWS
 *  reconnect argv rather than reimplementing it. Everything else is honestly
 *  unwired -- no `daemon-start`/`stdio-probe` row is declared anywhere in this
 *  codebase yet, so those two kinds exist as real, tested machinery reachable only
 *  through an injected `connectFor`, never through a currently-declared production row. */
export function defaultConnectFor(id: string): ConnectRunner | undefined {
  if (id.startsWith('mcp-')) {
    const name = id.slice(4);
    return {
      kind: 'mcp-login',
      argv: ['claude', 'mcp', 'login', name, '--no-browser'],
      // Same fleet-worker root as mcp-runner.ts's `fleetWorkerCwd()` -- `FORGE_WORKER_CWD`
      // overrides it, falling back to `workspaceRoot()` per this repo's no-hardcoded-paths
      // rule (`paths.ts`), rather than a literal drive-rooted directory in source.
      cwd: process.env['FORGE_WORKER_CWD'] ?? workspaceRoot(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: fleetConfigDir() },
    };
  }
  if (id === 'aws') {
    return { kind: 'aws-sso', argv: awsSsoLoginArgv() };
  }
  return undefined;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

const LINK_PATTERN = /https?:\/\/\S+/;

export interface IntegrationsConnectDeps {
  authorized: (request: IncomingMessage, response: ServerResponse) => boolean;
  registry: IntegrationsRegistry;
  /** Overrides the production id->runner mapping. A specimen always sets this. */
  connectFor?: (id: string) => ConnectRunner | undefined;
  /** Overrides `child_process.spawn`. A specimen records what it was called with and
   *  drives the fake child itself, matching the shape `exec.ts`'s `RunRequest.spawnFn`
   *  and the existing `fakeSpawn` test helper already use. */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /**
   * Publishes an `integrations` slice event on every state transition (connecting,
   * then the terminal state). This module calls it directly rather than going
   * through `sliceEventsFor`'s route table in `src/shared/console-events.ts`, since
   * that file belongs to the `console-live-spine` stream and never gets a
   * `MUTATING_ROUTES` entry here. `sliceEvent`'s `reason`/`ref` arguments carry only
   * a short reason string and `record.integrationId`; `record.link` never reaches
   * this call.
   */
  publish?: (event: Record<string, unknown>) => void;
}

export class IntegrationsConnectRoutes {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(private readonly deps: IntegrationsConnectDeps) {}

  static matches(path: string, method: string | undefined): boolean {
    if (CONNECT_ROUTE.test(path)) return method === 'POST';
    if (ATTEMPT_ROUTE.test(path)) return method === 'GET';
    return false;
  }

  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const connectMatch = path.match(CONNECT_ROUTE);
    if (connectMatch && request.method === 'POST') {
      if (!this.deps.authorized(request, response)) return true;
      await this.startConnect(decodeURIComponent(connectMatch[1]!), response);
      return true;
    }
    const attemptMatch = path.match(ATTEMPT_ROUTE);
    if (attemptMatch && request.method === 'GET') {
      if (!this.deps.authorized(request, response)) return true;
      this.readAttempt(decodeURIComponent(attemptMatch[1]!), attemptMatch[2]!, response);
      return true;
    }
    return false;
  }

  private async startConnect(id: string, response: ServerResponse): Promise<void> {
    const connectFor = this.deps.connectFor ?? defaultConnectFor;
    const runner = connectFor(id);
    if (!runner) {
      respond(response, 404, { error: `no connect action for ${id}` });
      return;
    }
    const attempt = randomUUID();
    const record: AttemptRecord = {
      integrationId: id, kind: runner.kind, state: 'connecting', link: null, linkRead: false, error: null,
    };
    this.attempts.set(attempt, record);
    await this.deps.registry.applyConnectResult(id, { mcpState: 'connecting' });
    this.deps.publish?.(sliceEvent('integrations', `${id} is connecting`, id));
    respond(response, 202, { attempt });
    void this.runAttempt(record, runner);
  }

  private readAttempt(id: string, attempt: string, response: ServerResponse): void {
    const record = this.attempts.get(attempt);
    if (!record || record.integrationId !== id) {
      respond(response, 404, { error: `no connect attempt ${attempt} for ${id}` });
      return;
    }
    const view: ConnectAttemptView = { state: record.state };
    if (record.error !== null) view.error = record.error;
    // The link is handed out exactly once, to whichever caller reads it first -- never
    // stored in the row, never broadcast, never present on a second read from anyone.
    if (record.link !== null && !record.linkRead) {
      view.link = record.link;
      record.linkRead = true;
    }
    respond(response, 200, view);
  }

  private async runAttempt(record: AttemptRecord, runner: ConnectRunner): Promise<void> {
    const spawnFn = this.deps.spawnFn ?? nodeSpawn;
    const timeoutMs = runner.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const [command, ...args] = runner.argv;
    let stderrTail = '';
    let settled = false;

    const child = spawnFn(command!, args, {
      cwd: runner.cwd ?? process.cwd(),
      env: runner.env ?? process.env,
    });

    const finish = async (state: McpConnState, error: string | null): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.state = state;
      record.error = error;
      const patch = state === 'connected'
        ? { mcpState: 'connected' as McpConnState, status: 'ok' as const }
        : { mcpState: state, lastError: error ?? undefined, status: 'off' as const };
      await this.deps.registry.applyConnectResult(record.integrationId, patch);
      this.deps.publish?.(sliceEvent('integrations', `${record.integrationId} is ${state}`, record.integrationId));
    };

    const timer = setTimeout(() => {
      void finish('failed', 'connect attempt timed out');
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (record.link !== null || runner.kind !== 'mcp-login') return;
      const text = String(chunk);
      const found = text.match(LINK_PATTERN);
      if (found) record.link = found[0];
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-4000);
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        void finish('connected', null);
      } else {
        const error = stderrTail.trim() || `exited with code ${code}`;
        void finish('failed', error);
      }
    });
  }
}
