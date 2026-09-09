/**
 * `gatherBlockers`: turns the inbox, the integrations registry, the lane view and an
 * injected `gh` reader into `DetectionInputs`, the shape `detectBlockers` (`blockers.ts`)
 * takes. Every `gh` call goes through an injected function -- a specimen never shells out.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatherBlockers, type GhRunListFn, type GhRunViewFn } from '../../../src/forge/console/blockers-gather.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { IntegrationsRegistry } from '../../../src/forge/console/integrations.js';
import { Registry } from '../../../src/forge/registry.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { LanesResponse } from '../../../src/shared/console-model.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blockers-gather-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function emptyLanesView(): LanesResponse {
  return { at: Date.now(), lanes: [], tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } };
}

describe('gatherBlockers', () => {
  it('reads open asks off the inbox', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    inbox.raise({ run: 'r1', question: 'which env?', options: ['dev', 'prod'] });
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });

    const gather = gatherBlockers({
      inbox, integrations, lanesView: emptyLanesView, registry,
    });
    const result = await gather();
    expect(result.asks).toHaveLength(1);
    expect(result.asks[0]?.question).toBe('which env?');
    expect(result.asks[0]?.runs).toEqual(['r1']);
  });

  it('reads down/off integrations off the registry', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'),
      probes: { github: async () => ({ status: 'down', latencyMs: null, detail: 'not authed' }) },
    });
    // `list()` answers from stored state and refreshes in the background (integrations.ts's
    // own contract); `check()` is the forced, waited read that actually stores a result.
    await integrations.check('github');

    const gather = gatherBlockers({ inbox, integrations, lanesView: emptyLanesView, registry });
    const result = await gather();
    const gh = result.integrations.find((row) => row.id === 'github');
    expect(gh?.status).toBe('down');
    expect(gh?.cause).toBe('not authed');
  });

  it('carries lanes through with mergeable and pr checks intact', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    const view: LanesResponse = {
      at: Date.now(), tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null },
      lanes: [{
        id: 'run-1', ticket: null, model: 'sonnet-5', modelId: null, className: null,
        repo: 'o/n', attempt: 1, state: 'blocked', reason: null, stepN: 0, stepTotal: 0,
        stepText: '', ctxTokens: 0, ctxCeiling: 0, ctxCompactAt: 0, tokens: 0, tokenCap: null,
        tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live', observedAt: 5, verifiedAt: null,
        heart: false, since: 5, startedAt: 5, endedAt: null, question: null,
        pr: { no: 12, url: 'https://github.com/o/n/pull/12', draft: false, checks: 'failure' },
        sandbox: null, blockedBy: null, runaway: false, needsAaron: null, title: 'a fix',
        kind: 'ticket', sourceUrl: null, plain: '', mergeable: { ok: false, why: 'checks failed' },
        attempts: 1, retiredAt: null, now: '', did: null, you: null,
        live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 },
      }],
    };
    const gather = gatherBlockers({ inbox, integrations, lanesView: () => view, registry });
    const result = await gather();
    expect(result.lanes).toEqual([{
      id: 'run-1', title: 'a fix', ticket: null, repo: 'o/n', state: 'blocked', observedAt: 5,
      pr: { no: 12, checks: 'failure' }, mergeable: { ok: false, why: 'checks failed' },
    }]);
  });

  it('marks a lane live in registryLive only when the registry has a row for it', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    registry.admit({ goal: 'run-live', cwd: dir, briefPath: join(dir, 'b.md'), pid: process.pid });
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    const view: LanesResponse = {
      at: Date.now(), tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null },
      lanes: [
        laneStub('run-live'),
        laneStub('run-dead'),
      ],
    };
    const gather = gatherBlockers({ inbox, integrations, lanesView: () => view, registry });
    const result = await gather();
    expect(result.registryLive.has('run-live')).toBe(true);
    expect(result.registryLive.has('run-dead')).toBe(false);
  });

  it('detects a billing refusal from a failed PR check through the injected gh readers, cached for 60s', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    const queueStore = new QueueStore(join(dir, 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'o/n',
      briefPath: 'b.md', branch: 'feature/bbz-1', worktreePath: 'w', base: 'develop',
      state: 'review', reason: null, runKey: 'run-1', pr: null, journalIds: [], createdAt: 1, updatedAt: 1,
    });
    const lane = { ...laneStub('run-1'), repo: 'o/n', pr: { no: 12, url: 'x', draft: false, checks: 'failure' as const } };
    const view: LanesResponse = { at: Date.now(), tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null }, lanes: [lane] };

    let runListCalls = 0;
    let runViewCalls = 0;
    const ghRunList: GhRunListFn = async () => {
      runListCalls += 1;
      return { databaseId: 555, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:05Z' };
    };
    const ghRunView: GhRunViewFn = async () => {
      runViewCalls += 1;
      return { jobs: [{ name: 'verify', steps: [] }] };
    };

    const gather = gatherBlockers({
      inbox, integrations, lanesView: () => view, registry, queueStore, ghRunList, ghRunView,
    });
    const first = await gather();
    expect(first.billing).toEqual([{ repo: 'o/n', pr: 12, runId: '555', headSha: '', message: expect.any(String) }]);
    expect(runListCalls).toBe(1);
    expect(runViewCalls).toBe(1);

    // A second gather inside 60s must not shell out again.
    const second = await gather();
    expect(second.billing).toHaveLength(1);
    expect(runListCalls).toBe(1);
    expect(runViewCalls).toBe(1);
  });

  it('does not flag billing when the failed run ran normal steps', async () => {
    const inbox = new Inbox(join(dir, 'inbox'));
    const registry = new Registry(join(dir, 'registry'));
    const integrations = new IntegrationsRegistry({
      journalPath: join(dir, 'fleet.jsonl'), ledger: { get: () => [] } as never, configPath: join(dir, 'integrations.json'), probes: {},
    });
    const queueStore = new QueueStore(join(dir, 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'o/n',
      briefPath: 'b.md', branch: 'feature/bbz-1', worktreePath: 'w', base: 'develop',
      state: 'review', reason: null, runKey: 'run-1', pr: null, journalIds: [], createdAt: 1, updatedAt: 1,
    });
    const lane = { ...laneStub('run-1'), repo: 'o/n', pr: { no: 12, url: 'x', draft: false, checks: 'failure' as const } };
    const view: LanesResponse = { at: Date.now(), tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null }, lanes: [lane] };

    const ghRunList: GhRunListFn = async () => (
      { databaseId: 555, conclusion: 'failure', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:05:00Z' }
    );
    const ghRunView: GhRunViewFn = async () => (
      { jobs: [{ name: 'verify', steps: [{ name: 'run tests', conclusion: 'failure' }] }] }
    );

    const gather = gatherBlockers({
      inbox, integrations, lanesView: () => view, registry, queueStore, ghRunList, ghRunView,
    });
    const result = await gather();
    expect(result.billing).toEqual([]);
  });
});

function laneStub(id: string): LanesResponse['lanes'][number] {
  return {
    id, ticket: null, model: 'sonnet-5', modelId: null, className: null,
    repo: null, attempt: 1, state: 'running', reason: null, stepN: 0, stepTotal: 0,
    stepText: '', ctxTokens: 0, ctxCeiling: 0, ctxCompactAt: 0, tokens: 0, tokenCap: null,
    tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live', observedAt: 5, verifiedAt: null,
    heart: false, since: 5, startedAt: 5, endedAt: null, question: null,
    pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null, title: null,
    kind: 'manual', sourceUrl: null, plain: '', now: '', did: null, you: null, mergeable: null, attempts: 1, retiredAt: null,
    live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 },
  };
}
