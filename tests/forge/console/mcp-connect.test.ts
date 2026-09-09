/**
 * `IntegrationsConnectRoutes` (`src/forge/console/integrations-route.ts`): the one
 * Connect action the console has never had. Scripted fake CLI throughout -- no real
 * network or OAuth. The load-bearing property under test is that the login link an
 * `mcp-login` attempt prints never reaches `IntegrationsRegistry.applyConnectResult`
 * (and, through it, the stored row / journal / any published event) -- it lives only
 * in the direct `GET .../connect/:attempt` response to whichever caller reads it first.
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import {
  awsSsoLoginArgv, IntegrationsRegistry,
} from '../../../src/forge/console/integrations.js';
import {
  defaultConnectFor, IntegrationsConnectRoutes, type ConnectRunner,
} from '../../../src/forge/console/integrations-route.js';

/** A `spawn` fake that hands back manual control over each child's stdout/stderr/close,
 *  rather than auto-resolving on the next tick -- the connect route's own response must
 *  come back before the attempt resolves, so the test needs to hold `close` open. */
function manualSpawn() {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const children: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter })[] = [];
  const spawnFn = (command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as unknown as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls, children };
}

function fakeHttp(method: string) {
  let status = 0;
  let body = '';
  const request = { method } as never;
  const response = {
    writeHead: (s: number) => { status = s; },
    end: (b: string) => { body = b; },
  } as never;
  return { request, response, read: () => ({ status, body: JSON.parse(body) as Record<string, unknown> }) };
}

let dir: string;
let journalPath: string;
let configPath: string;
let ledger: ActionsLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-mcp-connect-'));
  journalPath = join(dir, 'fleet.jsonl');
  configPath = join(dir, 'integrations.json');
  ledger = new ActionsLedger(join(dir, 'actions.jsonl'));
});

function registry(): IntegrationsRegistry {
  return new IntegrationsRegistry({ journalPath, ledger, configPath, everyS: 30, probes: {} });
}

describe('POST /integrations/:id/connect', () => {
  it('spawns exactly `claude mcp login <name> --no-browser` for an mcp-login row and returns {attempt} before the process resolves', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: spawn.spawnFn,
    });
    const http = fakeHttp('POST');

    const handled = await routes.handle('/integrations/mcp-slack/connect', http.request, http.response);

    expect(handled).toBe(true);
    // The child was spawned but never closed -- proves the response above did not wait on it.
    expect(spawn.children).toHaveLength(1);
    expect(spawn.calls[0]).toMatchObject({ command: 'claude', args: ['mcp', 'login', 'slack', '--no-browser'] });
    const { status, body } = http.read();
    expect(status).toBe(202);
    expect(typeof body['attempt']).toBe('string');
  });

  it('404s with the exact message shape for an id with no connect action', async () => {
    const reg = registry();
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: manualSpawn().spawnFn,
    });
    const http = fakeHttp('POST');

    await routes.handle('/integrations/jira/connect', http.request, http.response);

    const { status, body } = http.read();
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'no connect action for jira' });
  });

  it('aws-sso kind calls the shared awsSsoLoginArgv(), not a duplicated implementation', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: spawn.spawnFn,
    });
    const http = fakeHttp('POST');

    await routes.handle('/integrations/aws/connect', http.request, http.response);

    expect(spawn.calls[0]!.args).toEqual(awsSsoLoginArgv().slice(1));
    expect([spawn.calls[0]!.command, ...spawn.calls[0]!.args]).toEqual(awsSsoLoginArgv());
  });
});

describe('GET /integrations/:id/connect/:attempt', () => {
  it('answers {state: "connecting"} with no link before the process resolves', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: spawn.spawnFn,
    });
    const startHttp = fakeHttp('POST');
    await routes.handle('/integrations/mcp-slack/connect', startHttp.request, startHttp.response);
    const attempt = startHttp.read().body['attempt'] as string;

    const readHttp = fakeHttp('GET');
    await routes.handle(`/integrations/mcp-slack/connect/${attempt}`, readHttp.request, readHttp.response);

    const { status, body } = readHttp.read();
    expect(status).toBe(200);
    expect(body).toEqual({ state: 'connecting' });
    expect('link' in body).toBe(false);
  });

  it('hands the login link only to the first reader; a second read never receives it, and the URL never reaches applyConnectResult', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const applySpy = vi.spyOn(reg, 'applyConnectResult');
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: spawn.spawnFn,
    });
    const startHttp = fakeHttp('POST');
    await routes.handle('/integrations/mcp-slack/connect', startHttp.request, startHttp.response);
    const attempt = startHttp.read().body['attempt'] as string;

    const loginUrl = 'https://mcp.slack.com/oauth/authorize?state=abc123secret';
    spawn.children[0]!.stdout.emit('data', Buffer.from(`Visit ${loginUrl} to finish signing in\n`));

    const firstRead = fakeHttp('GET');
    await routes.handle(`/integrations/mcp-slack/connect/${attempt}`, firstRead.request, firstRead.response);
    expect(firstRead.read().body['link']).toBe(loginUrl);

    const secondRead = fakeHttp('GET');
    await routes.handle(`/integrations/mcp-slack/connect/${attempt}`, secondRead.request, secondRead.response);
    expect('link' in secondRead.read().body).toBe(false);

    // Resolve the attempt now that both reads happened, and prove the URL string never
    // appeared in any argument to applyConnectResult across the whole attempt.
    spawn.children[0]!.emit('close', 0);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(applySpy).toHaveBeenCalled();
    for (const call of applySpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(loginUrl);
      expect(serialized).not.toContain('secret');
    }
  });

  it('a failed attempt resolves applyConnectResult with the verbatim stderr, not a generic message', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const applySpy = vi.spyOn(reg, 'applyConnectResult');
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: spawn.spawnFn,
    });
    const startHttp = fakeHttp('POST');
    await routes.handle('/integrations/mcp-slack/connect', startHttp.request, startHttp.response);
    const attempt = startHttp.read().body['attempt'] as string;

    const stderrText = 'error: token exchange failed: invalid_grant';
    spawn.children[0]!.stderr.emit('data', Buffer.from(stderrText));
    spawn.children[0]!.emit('close', 1);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(applySpy).toHaveBeenCalledWith('mcp-slack', {
      mcpState: 'failed', lastError: stderrText, status: 'off',
    });

    const readHttp = fakeHttp('GET');
    await routes.handle(`/integrations/mcp-slack/connect/${attempt}`, readHttp.request, readHttp.response);
    const { body } = readHttp.read();
    expect(body['state']).toBe('failed');
    expect(body['error']).toBe(stderrText);
  });

  it('404s for an unknown attempt id', async () => {
    const reg = registry();
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: manualSpawn().spawnFn,
    });
    const readHttp = fakeHttp('GET');

    await routes.handle('/integrations/mcp-slack/connect/no-such-attempt', readHttp.request, readHttp.response);

    const { status, body } = readHttp.read();
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'no connect attempt no-such-attempt for mcp-slack' });
  });
});

describe('a successful connect attempt', () => {
  it('resolves applyConnectResult with mcpState connected and status ok', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const applySpy = vi.spyOn(reg, 'applyConnectResult');
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: spawn.spawnFn,
    });
    const startHttp = fakeHttp('POST');
    await routes.handle('/integrations/mcp-slack/connect', startHttp.request, startHttp.response);

    spawn.children[0]!.emit('close', 0);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(applySpy).toHaveBeenCalledWith('mcp-slack', { mcpState: 'connected', status: 'ok' });
  });
});

describe('slice-event publish', () => {
  it('publishes an integrations event when the attempt starts and again when it resolves, neither one carrying the login link', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const published: Record<string, unknown>[] = [];
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true,
      registry: reg,
      connectFor: defaultConnectFor,
      spawnFn: spawn.spawnFn,
      publish: (event) => published.push(event),
    });
    const startHttp = fakeHttp('POST');

    await routes.handle('/integrations/mcp-slack/connect', startHttp.request, startHttp.response);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ slice: 'integrations' });

    const loginUrl = 'https://mcp.slack.com/oauth/authorize?state=abc123secret';
    spawn.children[0]!.stdout.emit('data', Buffer.from(`Visit ${loginUrl} to finish signing in\n`));
    spawn.children[0]!.emit('close', 0);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ slice: 'integrations' });
    for (const event of published) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(loginUrl);
      expect(serialized).not.toContain('secret');
    }
  });

  it('skips publishing without throwing when no publish dependency is supplied', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: defaultConnectFor, spawnFn: spawn.spawnFn,
    });
    const startHttp = fakeHttp('POST');

    await routes.handle('/integrations/mcp-slack/connect', startHttp.request, startHttp.response);
    spawn.children[0]!.emit('close', 0);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(startHttp.read().status).toBe(202);
  });
});

describe('an injected connectFor', () => {
  it('is used verbatim for a custom kind, proving argv/cwd/env pass through unmodified', async () => {
    const spawn = manualSpawn();
    const reg = registry();
    const runner: ConnectRunner = {
      kind: 'daemon-start', argv: ['knowledge', '--start'], cwd: 'X:/fake-workers/knowledge', env: { FOO: 'bar' },
    };
    const routes = new IntegrationsConnectRoutes({
      authorized: () => true, registry: reg, connectFor: (id) => (id === 'knowledge' ? runner : undefined),
      spawnFn: spawn.spawnFn,
    });
    const http = fakeHttp('POST');

    await routes.handle('/integrations/knowledge/connect', http.request, http.response);

    expect(spawn.calls[0]).toMatchObject({
      command: 'knowledge', args: ['--start'], options: { cwd: 'X:/fake-workers/knowledge', env: { FOO: 'bar' } },
    });
  });
});
