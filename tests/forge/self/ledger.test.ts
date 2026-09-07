import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FindingsLedger } from '../../../src/forge/self/ledger.js';
import type { SelfFinding } from '../../../src/forge/self/analyze.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-self-ledger-'));
  path = join(dir, 'findings.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function finding(id: string): SelfFinding {
  return { id, kind: 'gotcha-fix-lane', signature: id, summary: 's', evidence: ['e'] };
}

describe('FindingsLedger', () => {
  it('records a new finding and returns it back from all()', () => {
    const ledger = new FindingsLedger(path);
    ledger.record(finding('f1'), 1000);
    expect(ledger.all().map((r) => r.id)).toEqual(['f1']);
  });

  it('is idempotent by id: recording the same finding twice appends only once', () => {
    const ledger = new FindingsLedger(path);
    ledger.record(finding('f1'), 1000);
    ledger.record(finding('f1'), 2000);
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(rows).toHaveLength(1);
    expect(ledger.all()).toHaveLength(1);
  });

  it('marks a finding enqueued and a fresh reader sees it', () => {
    const ledger = new FindingsLedger(path);
    ledger.record(finding('f1'), 1000);
    ledger.markEnqueued('f1', 'Q-abc', 2000);

    const reread = new FindingsLedger(path);
    const row = reread.get('f1');
    expect(row?.enqueuedItemId).toBe('Q-abc');
  });

  it('does not mark an id it never recorded', () => {
    const ledger = new FindingsLedger(path);
    expect(() => ledger.markEnqueued('nope', 'Q-x', 1)).not.toThrow();
    expect(ledger.get('nope')).toBeUndefined();
  });
});
