/**
 * `buildConfirmers`: one `Confirmer` per `BlockerKind`, each answering whether a blocker's
 * claimed fix actually took. Every `gh` call goes through an injected function -- a
 * specimen never shells out.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConfirmers } from '../../../src/forge/console/blockers-confirm.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { IntegrationsRegistry } from '../../../src/forge/console/integrations.js';
import { Registry } from '../../../src/forge/registry.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { Blocker } from '../../../src/shared/console-model.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blockers-confirm-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function blockerStub(overrides: Partial<Blocker>): Blocker {
  return {
    id: 'question:abc', kind: 'question', title: 't', detail: 'd', youCanResolve: true,
    howToResolve: 'h', links: [], blocks: [], blockedBy: [], state: 'open', since: 1,
    checkedAt: null, resolvedAt: null, thenWhat: '', lastCheck: null, ...overrides,
  };
}

describe('question confirmer', () => {
  it('confirms once the ask no longer reads open', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    inbox.raise({ run: 'r1', question: 'which env?' });
    const [entry] = inbox.open();
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    const confirmers = buildConfirmers({ inbox, integrations, registry });

    const stillOpen = await confirmers.question!(blockerStub({ id: `question:${entry!.key}` }));
    expect(stillOpen.ok).toBe(false);

    inbox.answer(entry!.key, 'dev');
    const answered = await confirmers.question!(blockerStub({ id: `question:${entry!.key}` }));
    expect(answered.ok).toBe(true);
  });
});

describe('integration confirmer', () => {
  it('runs the row\'s probe now and reads ok off it', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    let up = false;
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'),
      probes: { github: async () => (up ? { status: 'ok', latencyMs: 5 } : { status: 'down', latencyMs: null, detail: 'still down' }) },
    });
    const confirmers = buildConfirmers({ inbox, integrations, registry });

    const down = await confirmers.integration!(blockerStub({ id: 'integration:github', kind: 'integration' }));
    expect(down).toEqual({ ok: false, detail: 'still down' });

    up = true;
    const nowOk = await confirmers.integration!(blockerStub({ id: 'integration:github', kind: 'integration' }));
    expect(nowOk.ok).toBe(true);
  });
});

describe('checks confirmer', () => {
  it('confirms only once every check reads SUCCESS, and names pending checks otherwise', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    let checks: Array<{ name: string; state: string }> = [{ name: 'build', state: 'PENDING' }];
    const confirmers = buildConfirmers({
      inbox, integrations, registry, ghPrChecks: async () => checks,
    });

    const pending = await confirmers.checks!(blockerStub({ id: 'checks:o/n#12', kind: 'checks' }));
    expect(pending).toEqual({ ok: false, detail: 'checks are still running' });

    checks = [{ name: 'build', state: 'SUCCESS' }];
    const green = await confirmers.checks!(blockerStub({ id: 'checks:o/n#12', kind: 'checks' }));
    expect(green.ok).toBe(true);
  });
});

describe('billing confirmer', () => {
  it('reruns the failed workflow and confirms once a job reports startedAt', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    const queueStore = new QueueStore(join(dir, 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'o/n',
      briefPath: 'b.md', branch: 'feature/bbz-1', worktreePath: 'w', base: 'develop',
      state: 'review', reason: null, runKey: 'run-1',
      pr: { no: 12, url: 'x', draft: false }, journalIds: [], createdAt: 1, updatedAt: 1,
    });
    let reran = false;
    let polls = 0;
    const confirmers = buildConfirmers({
      inbox, integrations, registry, queueStore,
      ghRunList: async () => ({ databaseId: 999, conclusion: 'failure', createdAt: 't1', updatedAt: 't2' }),
      ghRunRerun: async () => { reran = true; },
      ghRunView: async () => {
        polls += 1;
        return { jobs: [{ name: 'verify', startedAt: polls > 1 ? '2026-01-01T00:00:00Z' : null }] };
      },
      pollIntervalMs: 1,
    });

    const result = await confirmers.billing!(blockerStub({
      id: 'billing:o/n', kind: 'billing', detail: 'The verify jobs on PR #12 were refused: "billing is off".',
    }));
    expect(reran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('verify');
  });
});

describe('owner confirmer', () => {
  it('confirms once the PR carries a mergedAt', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    let merged: string | null = null;
    const confirmers = buildConfirmers({
      inbox, integrations, registry, ghPrMergedAt: async () => merged,
    });

    const notYet = await confirmers.owner!(blockerStub({ id: 'owner:o/n#12', kind: 'owner' }));
    expect(notYet.ok).toBe(false);

    merged = '2026-01-01T00:00:00Z';
    const done = await confirmers.owner!(blockerStub({ id: 'owner:o/n#12', kind: 'owner' }));
    expect(done.ok).toBe(true);
  });
});

describe('process confirmer', () => {
  it('confirms once the registry has a row again for a blocked lane', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    const confirmers = buildConfirmers({ inbox, integrations, registry });
    const blocker = blockerStub({
      id: 'process:run-1', kind: 'process', blocks: [{ laneId: 'run-1', label: 'run-1' }],
    });

    const gone = await confirmers.process!(blocker);
    expect(gone.ok).toBe(false);

    registry.admit({ goal: 'run-1', cwd: dir, briefPath: join(dir, 'b.md'), pid: process.pid });
    const back = await confirmers.process!(blocker);
    expect(back.ok).toBe(true);
  });
});
