import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import { IntegrationsRegistry, type Probe } from '../../../src/forge/console/integrations.js';

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
