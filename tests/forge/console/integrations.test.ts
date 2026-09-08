import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import {
  commandOnPath, IntegrationsRegistry, modelProviderProbeResult, stdioMcpProbe, type Probe,
  type ProbeResult,
} from '../../../src/forge/console/integrations.js';
import type { Lane, LanesResponse } from '../../../src/shared/console-model.js';

function fakeSpawn(returncode: number, stdout: string) {
  return () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    setImmediate(() => {
      (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(stdout));
      child.emit('close', returncode);
    });
    return child;
  };
}

let dir: string;
let journalPath: string;
let configPath: string;
let ledger: ActionsLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-integrations-'));
  journalPath = join(dir, 'fleet.jsonl');
  configPath = join(dir, 'integrations.json');
  ledger = new ActionsLedger(join(dir, 'actions.jsonl'));
});

function up(): Probe {
  return async () => ({ status: 'ok', latencyMs: 12 });
}

function down(): Probe {
  return async () => ({ status: 'down', latencyMs: null });
}

function lane(overrides: Partial<Lane>): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-211', ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'blocked', reason: 'aws down', stepN: 0, stepTotal: 6, stepText: 'blocked',
    ctxTokens: 0, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 0, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'blocked', observedAt: Date.now(), verifiedAt: null, heart: false, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: 'aws',
    runaway: false, needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, now: '', you: null,
    ...overrides,
  };
}

function lanesView(lanes: Lane[]): () => LanesResponse {
  return () => ({ at: Date.now(), lanes, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } });
}

describe('IntegrationsRegistry.list', () => {
  it('probes every declared integration and persists the result', async () => {
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: { github: up(), jira: down(), 'model-provider': up(), codex: up(), aws: up() },
    });

    const result = await registry.list(true);

    const github = result.items.find((item) => item.id === 'github');
    const jira = result.items.find((item) => item.id === 'jira');
    expect(github?.status).toBe('ok');
    expect(jira?.status).toBe('down');
    expect(jira?.fix).toBeTruthy();

    const stored = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(stored.rows.github.status).toBe('ok');
  });

  it('does not re-probe within everyS, only after it', async () => {
    let calls = 0;
    const countingProbe: Probe = async () => { calls += 1; return { status: 'ok', latencyMs: 1 }; };
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath, everyS: 30,
      probes: { github: countingProbe, jira: up(), 'model-provider': up(), codex: up(), aws: up() },
    });

    // A poll answers from the store and refreshes behind the response, so let the first
    // refresh settle before polling again; the second must reuse what the first wrote.
    await registry.list(false);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    await registry.list(false);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(calls).toBe(1);
  });

  // The load run measured `GET /integrations` at 9.4s on a busy fleet, because a poll
  // every five seconds awaited a serial run of `gh`, `aws` and one shell per MCP server.
  // A poll must never wait on an external tool: it answers from the last stored result
  // and lets the refresh land behind it.
  it('answers a poll without waiting on a slow probe', async () => {
    const journalPath = join(mkdtempSync(join(tmpdir(), 'integrations-slow-')), 'fleet.jsonl');
    const configPath = join(mkdtempSync(join(tmpdir(), 'integrations-slow-cfg-')), 'integrations.json');
    const ledger = new ActionsLedger(join(mkdtempSync(join(tmpdir(), 'integrations-slow-led-')), 'actions.jsonl'));
    const slow = async (): Promise<ProbeResult> => {
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      return { status: 'ok', latencyMs: 300 };
    };
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath, everyS: 30,
      probes: { github: slow, jira: slow, 'model-provider': slow, codex: slow, aws: slow },
    });

    const started = Date.now();
    await registry.list(false);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(150);
  });
});

describe('IntegrationsRegistry down-plate copy', () => {
  it('names the probe detail as cause and the actually-blocked lanes as effect', async () => {
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: {
        github: up(), jira: up(), 'model-provider': up(), codex: up(),
        aws: async () => ({ status: 'down', latencyMs: null, detail: 'FORGE_AWS_PROFILE is not set' }),
      },
      lanesView: lanesView([
        lane({ id: 'FLT-211', blockedBy: 'aws' }),
        lane({ id: 'FLT-212', blockedBy: 'aws' }),
        lane({ id: 'FLT-213', blockedBy: 'jira' }),
      ]),
    });

    const result = await registry.list(true);
    const aws = result.items.find((item) => item.id === 'aws');

    expect(aws?.cause).toBe('FORGE_AWS_PROFILE is not set');
    expect(aws?.effect).toContain('FLT-211');
    expect(aws?.effect).toContain('FLT-212');
    expect(aws?.effect).not.toContain('FLT-213');
    expect(aws?.dependents).toEqual(['FLT-211', 'FLT-212']);
  });

  it('reads no lanes blocked, not a generic cause, when the probe gives no detail and nothing depends on it', async () => {
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: { github: up(), jira: up(), 'model-provider': up(), codex: up(), aws: down() },
      lanesView: lanesView([]),
    });

    const result = await registry.list(true);
    const aws = result.items.find((item) => item.id === 'aws');

    expect(aws?.effect).toBe('no lane is currently blocked on AWS');
  });

  it('tracks lastHealthyAt and increments retryCount across consecutive down probes, resetting on recovery', async () => {
    let status: 'ok' | 'down' = 'down';
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath, everyS: 0,
      probes: {
        github: up(), jira: up(), 'model-provider': up(), codex: up(),
        aws: async () => ({ status, latencyMs: status === 'ok' ? 5 : null }),
      },
    });

    const first = await registry.list(true);
    expect(first.items.find((i) => i.id === 'aws')?.retryCount).toBe(1);
    expect(first.items.find((i) => i.id === 'aws')?.lastHealthyAt).toBeNull();

    const second = await registry.list(true);
    expect(second.items.find((i) => i.id === 'aws')?.retryCount).toBe(2);

    status = 'ok';
    const third = await registry.list(true);
    const awsThird = third.items.find((i) => i.id === 'aws');
    expect(awsThird?.retryCount).toBe(0);
    expect(awsThird?.lastHealthyAt).not.toBeNull();
  });
});

describe('IntegrationsRegistry.check', () => {
  it('forces a fresh probe regardless of staleness', async () => {
    let calls = 0;
    const countingProbe: Probe = async () => { calls += 1; return { status: 'ok', latencyMs: 1 }; };
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: { github: countingProbe, jira: up(), 'model-provider': up(), codex: up(), aws: up() },
    });

    await registry.list(false);
    await registry.check('github');

    expect(calls).toBe(2);
  });
});

describe('IntegrationsRegistry.reconnect', () => {
  it('runs the declared reconnect, re-probes, and journals blocker.cleared when it recovers', async () => {
    let reconnected = false;
    let status = 'down';
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: {
        github: async () => ({ status: status as 'ok' | 'down', latencyMs: status === 'ok' ? 5 : null }),
        jira: up(), 'model-provider': up(), codex: up(), aws: up(),
      },
      reconnects: {
        github: async () => { reconnected = true; status = 'ok'; },
      },
    });

    const result = await registry.reconnect('github');

    expect(reconnected).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.steps.every((step) => step.done)).toBe(true);

    const journalLines = readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(journalLines.some((row) => row.event === 'blocker.cleared')).toBe(true);
  });

  // W3: the row says which id has no connect action and which slice will wire it,
  // and the row it hands back reports `canConnect: false` so the console renders no
  // connect button at all rather than one that can only refuse.
  it('names the id and the slice for an integration with no declared reconnect command', async () => {
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: { github: up(), jira: down(), 'model-provider': up(), codex: up(), aws: up() },
      reconnects: {},
    });

    const result = await registry.reconnect('jira');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('failed: no connect action for jira yet (S3)');
    expect(result.integration.canConnect).toBe(false);
  });

  it('reports canConnect on the rows that do have a connect action', async () => {
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: { github: up(), jira: down(), 'model-provider': up(), codex: up(), aws: up() },
      reconnects: { aws: async () => undefined },
    });

    const { items } = await registry.list(false);

    expect(items.find((i) => i.id === 'aws')?.canConnect).toBe(true);
    expect(items.find((i) => i.id === 'jira')?.canConnect).toBe(false);
  });
});

describe('modelProviderProbeResult', () => {
  it('is ok when the fleet config dir holds a credentials file', () => {
    const result = modelProviderProbeResult({
      exists: (path) => path.endsWith('.credentials.json'),
      readdir: () => [],
      processes: () => [],
    });
    expect(result).toBe(true);
  });

  it('is ok when the fleet config dir has a non-empty session store, with no credentials file', () => {
    const result = modelProviderProbeResult({
      exists: (path) => path.endsWith('projects'),
      readdir: () => ['session-1.jsonl'],
      processes: () => [],
    });
    expect(result).toBe(true);
  });

  it("is ok when forge status's own process classification sees a login or worker process", () => {
    const result = modelProviderProbeResult({
      exists: () => false,
      readdir: () => [],
      processes: () => [{ pid: 1, isLogin: true, kind: 'login' }],
    });
    expect(result).toBe(true);

    const workerResult = modelProviderProbeResult({
      exists: () => false,
      readdir: () => [],
      processes: () => [{ pid: 2, isLogin: false, kind: 'worker' }],
    });
    expect(workerResult).toBe(true);
  });

  it('is off when nothing on disk or in the process list backs a fleet login', () => {
    const result = modelProviderProbeResult({
      exists: () => false,
      readdir: () => [],
      processes: () => [{ pid: 3, isLogin: false, kind: 'interactive' }],
    });
    expect(result).toBe(false);
  });

  it('is off, not thrown, when the process probe itself failed', () => {
    const result = modelProviderProbeResult({
      exists: () => false,
      readdir: () => [],
      processes: () => ({ ok: false, reason: 'no process table' }),
    });
    expect(result).toBe(false);
  });
});

describe('commandOnPath', () => {
  it('is true when the finder resolves the command', async () => {
    const result = await commandOnPath('some-tool', fakeSpawn(0, 'found it'));
    expect(result).toBe(true);
  });

  it('is false when the finder cannot find the command', async () => {
    const result = await commandOnPath('missing-tool', fakeSpawn(1, ''));
    expect(result).toBe(false);
  });
});

describe('stdioMcpProbe', () => {
  it('reads ok with "stdio - command found" once the command resolves on PATH', async () => {
    const probe = stdioMcpProbe('some-tool', fakeSpawn(0, 'found it'));
    const result = await probe();
    expect(result).toEqual({ status: 'ok', latencyMs: null, desc: 'stdio · command found' });
  });

  it('reads down with "stdio - command not on PATH" when it does not', async () => {
    const probe = stdioMcpProbe('missing-tool', fakeSpawn(1, ''));
    const result = await probe();
    expect(result).toEqual({ status: 'down', latencyMs: null, desc: 'stdio · command not on PATH' });
  });
});

describe('jiraMyselfUrl', () => {
  it('accepts the site with or without its scheme and never doubles it', async () => {
    const { jiraMyselfUrl } = await import('../../../src/forge/console/integrations.js');
    expect(jiraMyselfUrl('https://acme.atlassian.net')).toBe('https://acme.atlassian.net/rest/api/3/myself');
    expect(jiraMyselfUrl('acme.atlassian.net/')).toBe('https://acme.atlassian.net/rest/api/3/myself');
  });
});
