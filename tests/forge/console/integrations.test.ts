import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import {
  commandOnPath, IntegrationsRegistry, modelProviderProbeResult, stdioMcpProbe, type Probe,
} from '../../../src/forge/console/integrations.js';

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

describe('IntegrationsRegistry.list', () => {
  it('probes every declared integration and persists the result', async () => {
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: { github: up(), jira: down(), 'model-provider': up(), codex: up(), aws: up() },
    });

    const result = await registry.list(false);

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

    await registry.list(false);
    await registry.list(false);

    expect(calls).toBe(1);
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

  it('answers not wired for an integration with no declared reconnect command', async () => {
    const registry = new IntegrationsRegistry({
      journalPath, ledger, configPath,
      probes: { github: up(), jira: down(), 'model-provider': up(), codex: up(), aws: up() },
      reconnects: {},
    });

    const result = await registry.reconnect('jira');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not wired/);
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
