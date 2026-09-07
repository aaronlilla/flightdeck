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
