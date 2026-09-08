import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enqueueFindings, type SelfEnqueueDeps } from '../../../src/forge/self/enqueue.js';
import { FindingsLedger } from '../../../src/forge/self/ledger.js';
import type { SelfFinding } from '../../../src/forge/self/analyze.js';
import { QueueStore } from '../../../src/forge/intake/queueStore.js';

let dir: string;
let deps: SelfEnqueueDeps;
let store: QueueStore;
let appended: Array<Record<string, unknown>>;

function finding(id: string, summary = 'summary'): SelfFinding {
  return { id, kind: 'gotcha-fix-lane', signature: id, summary, evidence: [`evidence for ${id}`] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-self-enqueue-'));
  store = new QueueStore(join(dir, 'queue.jsonl'));
  appended = [];
  deps = {
    store,
    briefsDir: join(dir, 'briefs'),
    ledger: new FindingsLedger(join(dir, 'findings.jsonl')),
    selfRepo: 'owner/flightdeck',
    maxInFlight: 1,
    clock: () => 5000,
    append: (event) => {
      appended.push(event);
      return { id: `j-${appended.length}` };
    },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('enqueueFindings', () => {
  it('turns a finding into one queue item, already routed to the self repo', () => {
    const items = enqueueFindings([finding('f1')], deps);
    expect(items).toHaveLength(1);
    expect(items[0]!.repo).toBe('owner/flightdeck');
    expect(items[0]!.source).toBe('brief');
    expect(items[0]!.briefPath).toBeTruthy();
  });

  it('writes a brief that carries the evidence and a failing-test-first DoD', () => {
    const items = enqueueFindings([finding('f1', 'fix the thing')], deps);
    const text = readFileSync(items[0]!.briefPath!, 'utf8');
    expect(text).toContain('fix the thing');
    expect(text).toContain('evidence for f1');
    expect(text.toLowerCase()).toContain('failing test');
  });

  it('journals self.finding and self.enqueued for a new finding', () => {
    enqueueFindings([finding('f1')], deps);
    const names = appended.map((e) => e['event']);
    expect(names).toContain('self.finding');
    expect(names).toContain('self.enqueued');
  });

  it('is idempotent: enqueuing the same finding twice never produces a second item', () => {
    enqueueFindings([finding('f1')], deps);
    const second = enqueueFindings([finding('f1')], deps);
    expect(second).toHaveLength(0);
    expect(store.all()).toHaveLength(1);
  });

  it('never queues more than maxInFlight self items at once', () => {
    const items = enqueueFindings([finding('f1'), finding('f2')], deps);
    expect(items).toHaveLength(1);
    expect(store.all().filter((i) => i.repo === 'owner/flightdeck')).toHaveLength(1);
  });

  it('does nothing when FORGE_SELF_REPO is not configured', () => {
    const items = enqueueFindings([finding('f1')], { ...deps, selfRepo: '' });
    expect(items).toHaveLength(0);
    expect(store.all()).toHaveLength(0);
  });

  it('counts an already in-flight self item against the ceiling', () => {
    enqueueFindings([finding('f1')], deps);
    const items = enqueueFindings([finding('f2')], deps);
    expect(items).toHaveLength(0);
  });
});

describe('observation kinds never become queue items', () => {
  it('records a token-outlier in the ledger and queues nothing for it', async () => {
    const { enqueueFindings, OBSERVATION_KINDS } = await import('../../../src/forge/self/enqueue.js');
    expect(OBSERVATION_KINDS.has('token-outlier')).toBe(true);
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { QueueStore } = await import('../../../src/forge/intake/queueStore.js');
    const { FindingsLedger } = await import('../../../src/forge/self/ledger.js');
    const dir = mkdtempSync(join(tmpdir(), 'forge-obs-'));
    const store = new QueueStore(join(dir, 'q.jsonl'));
    const ledger = new FindingsLedger(join(dir, 'f.jsonl'));
    const created = enqueueFindings([
      { id: 'abcdef0123456789', kind: 'token-outlier', signature: 'x', summary: 'run used 12M tokens', evidence: ['12M'] } as never,
    ], { store, briefsDir: join(dir, 'briefs'), ledger, selfRepo: 'owner/self', maxInFlight: 1, clock: () => 1000, append: () => ({ id: 'e' }) });
    expect(created).toEqual([]);
    expect(store.all()).toEqual([]);
    expect(ledger.all().map((r) => r.kind)).toEqual(['token-outlier']);
  });
});

describe('one self item per gap, whatever became of the last one', () => {
  it('queues nothing while the newest self item is younger than the gap, even if it parked', async () => {
    const { enqueueFindings } = await import('../../../src/forge/self/enqueue.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { QueueStore } = await import('../../../src/forge/intake/queueStore.js');
    const { FindingsLedger } = await import('../../../src/forge/self/ledger.js');
    const dir = mkdtempSync(join(tmpdir(), 'forge-gap-'));
    const store = new QueueStore(join(dir, 'q.jsonl'));
    const ledger = new FindingsLedger(join(dir, 'f.jsonl'));
    const deps = (now: number) => ({ store, briefsDir: join(dir, 'briefs'), ledger, selfRepo: 'owner/self', maxInFlight: 1, minGapMs: 3_600_000, clock: () => now, append: () => ({ id: 'e' }) });
    const first = enqueueFindings([{ id: 'aaaaaaaaaaaaaaaa', kind: 'gotcha-fix-lane', signature: 'a', summary: 'a', evidence: [] } as never], deps(1_000_000));
    expect(first).toHaveLength(1);
    store.append({ id: first[0]!.id, at: 1_000_500, state: 'parked', reason: 'unclear', updatedAt: 1_000_500 } as never);
    const second = enqueueFindings([{ id: 'bbbbbbbbbbbbbbbb', kind: 'gotcha-fix-lane', signature: 'b', summary: 'b', evidence: [] } as never], deps(1_000_000 + 30 * 60_000));
    expect(second).toEqual([]);
    const later = enqueueFindings([{ id: 'bbbbbbbbbbbbbbbb', kind: 'gotcha-fix-lane', signature: 'b', summary: 'b', evidence: [] } as never], deps(1_000_000 + 61 * 60_000));
    expect(later).toHaveLength(1);
  });
});
