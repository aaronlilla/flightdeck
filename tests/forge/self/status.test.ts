import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selfStatus } from '../../../src/forge/self/status.js';
import { FindingsLedger } from '../../../src/forge/self/ledger.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';
import type { SelfFinding } from '../../../src/forge/self/analyze.js';

let dir: string;
let ledger: FindingsLedger;
let store: QueueStore;

function finding(id: string): SelfFinding {
  return { id, kind: 'gotcha-fix-lane', signature: id, summary: 's', evidence: [] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-self-status-'));
  ledger = new FindingsLedger(join(dir, 'findings.jsonl'));
  store = new QueueStore(join(dir, 'queue.jsonl'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('selfStatus', () => {
  it('reports zeros and no last-analysis time on an empty ledger', () => {
    const status = selfStatus(ledger, store, 'owner/flightdeck');
    expect(status).toEqual({ findingsTotal: 0, queued: 0, merged: 0, lastAnalysisAt: null });
  });

  it('counts findings, in-flight self items and done self items', () => {
    ledger.record(finding('f1'), 1000);
    ledger.record(finding('f2'), 2000);
    store.append({
      id: 'S-f1', at: 1000, source: 'brief', input: 'x', ticket: 'S-f1', repo: 'owner/flightdeck',
      briefPath: 'b.md', branch: null, worktreePath: null, base: null, state: 'running', reason: null,
      runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    store.append({
      id: 'S-f2', at: 1000, source: 'brief', input: 'x', ticket: 'S-f2', repo: 'owner/flightdeck',
      briefPath: 'b.md', branch: null, worktreePath: null, base: null, state: 'done', reason: null,
      runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });
    // A non-self item on another repo must never be counted.
    store.append({
      id: 'Q-other', at: 1000, source: 'brief', input: 'x', ticket: 'Q-other', repo: 'owner/other',
      briefPath: 'b.md', branch: null, worktreePath: null, base: null, state: 'running', reason: null,
      runKey: null, pr: null, journalIds: [], createdAt: 1000, updatedAt: 1000,
    });

    const status = selfStatus(ledger, store, 'owner/flightdeck');
    expect(status.findingsTotal).toBe(2);
    expect(status.queued).toBe(1);
    expect(status.merged).toBe(1);
    expect(status.lastAnalysisAt).toBe(2000);
  });
});
