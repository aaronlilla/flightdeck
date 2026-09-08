/**
 * `buildRestarters`: what resumes once a blocker clears. A parked queue item retries
 * through the queue's own `retryItem`; a parked run resumes through the injected
 * `resumeRun`; a lane already running is left alone. Every restart that actually started
 * something leaves one rail receipt in words.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRestarters } from '../../../src/forge/console/blockers-restart.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { Blocker, LanesResponse } from '../../../src/shared/console-model.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blockers-restart-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function laneStub(id: string, state: LanesResponse['lanes'][number]['state']): LanesResponse['lanes'][number] {
  return {
    id, ticket: null, model: 'sonnet-5', modelId: null, className: null,
    repo: null, attempt: 1, state, reason: null, stepN: 0, stepTotal: 0,
    stepText: '', ctxTokens: 0, ctxCeiling: 0, ctxCompactAt: 0, tokens: 0, tokenCap: null,
    tokensPerMin: 0, fails: 0, hop: 0, hopStatus: 'live', observedAt: 5, verifiedAt: null,
    heart: false, since: 5, startedAt: 5, endedAt: null, question: null,
    pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null, title: null,
    kind: 'manual', sourceUrl: null, plain: '', now: '', did: null, you: null, mergeable: null, attempts: 1, retiredAt: null,
  };
}

function blockerStub(overrides: Partial<Blocker>): Blocker {
  return {
    id: 'integration:github', kind: 'integration', title: 'GitHub is not connecting',
    detail: 'd', youCanResolve: true, howToResolve: 'h', links: [], blocks: [], blockedBy: [],
    state: 'open', since: 1, checkedAt: null, resolvedAt: null, thenWhat: '', lastCheck: null,
    ...overrides,
  };
}

describe('buildRestarters', () => {
  it('has no restarter for question -- answering already resumes it', () => {
    const restarters = buildRestarters({
      queueStore: new QueueStore(join(dir, 'queue.jsonl')), lanesView: () => ({ at: 0, lanes: [], tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } }),
      resumeRun: async () => ({ ok: true }), appendReceipt: () => undefined,
    });
    expect(restarters.question).toBeUndefined();
  });

  it('retries a parked queue item through the queue\'s own path', async () => {
    const queueStore = new QueueStore(join(dir, 'queue.jsonl'));
    queueStore.append({
      id: 'Q-1', at: 1, source: 'ticket', input: 'BBZ-1', ticket: 'BBZ-1', repo: 'o/n',
      briefPath: 'b.md', branch: 'feature/bbz-1', worktreePath: 'w', base: 'develop',
      state: 'parked', reason: 'blocked on billing', runKey: 'run-1', pr: null,
      journalIds: [], createdAt: 1, updatedAt: 1,
    });
    const view: LanesResponse = { at: 0, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null }, lanes: [laneStub('run-1', 'blocked')] };
    let resumeCalls = 0;
    const receipts: string[] = [];
    const restarters = buildRestarters({
      queueStore, lanesView: () => view, resumeRun: async () => { resumeCalls += 1; return { ok: true }; },
      appendReceipt: (text) => { receipts.push(text); },
    });

    const started = await restarters.billing!(blockerStub({ kind: 'billing', blocks: [{ laneId: 'run-1', label: 'run-1' }] }), ['run-1']);
    expect(started).toEqual(['run-1']);
    expect(queueStore.get('Q-1')?.state).toBe('running');
    expect(resumeCalls).toBe(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('run-1');
  });

  it('resumes a parked run with no queue item through the injected resumeRun', async () => {
    const queueStore = new QueueStore(join(dir, 'queue.jsonl'));
    const view: LanesResponse = { at: 0, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null }, lanes: [laneStub('run-2', 'paused')] };
    let resumed: string[] = [];
    const restarters = buildRestarters({
      queueStore, lanesView: () => view,
      resumeRun: async (laneId) => { resumed.push(laneId); return { ok: true }; },
      appendReceipt: () => undefined,
    });

    const started = await restarters.integration!(blockerStub({ blocks: [{ laneId: 'run-2', label: 'run-2' }] }), ['run-2']);
    expect(started).toEqual(['run-2']);
    expect(resumed).toEqual(['run-2']);
  });

  it('skips a lane that is already running', async () => {
    const queueStore = new QueueStore(join(dir, 'queue.jsonl'));
    const view: LanesResponse = { at: 0, tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null }, lanes: [laneStub('run-3', 'running')] };
    let resumeCalls = 0;
    const restarters = buildRestarters({
      queueStore, lanesView: () => view, resumeRun: async () => { resumeCalls += 1; return { ok: true }; },
      appendReceipt: () => undefined,
    });

    const started = await restarters.process!(blockerStub({ kind: 'process', blocks: [{ laneId: 'run-3', label: 'run-3' }] }), ['run-3']);
    expect(started).toEqual([]);
    expect(resumeCalls).toBe(0);
  });
});
