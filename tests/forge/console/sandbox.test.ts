import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainPacketState } from '../../../src/forge/chain.js';
import { computeSandbox, newestLogFile, tailLog } from '../../../src/forge/console/sandbox.js';

describe('computeSandbox', () => {
  it('is null with no provision row and no registry row', () => {
    expect(computeSandbox('alpha', new Map(), undefined)).toBeNull();
  });

  it('carries path/branch from the chain provision row, pid/session from the registry', () => {
    const chain = new Map<string, ChainPacketState>([
      ['p1', { packetId: 'p1', launched: { runKey: 'alpha' }, provisioned: { worktreePath: 'w', branch: 'feature/ab-1' } }],
    ]);
    const result = computeSandbox('alpha', chain, { goal: 'alpha', cwd: 'w', briefPath: 'b.md', pid: 42, startedAt: 0, sessionId: 's1' });
    expect(result).toEqual({ id: 'alpha', path: 'w', branch: 'feature/ab-1', pid: 42, sessionId: 's1' });
  });
});

describe('newestLogFile + tailLog', () => {
  it('finds the most recently written file and tails it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'console-sandbox-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.log'), 'line1\n');
    writeFileSync(join(dir, 'new.log'), Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n'));

    const newest = newestLogFile(dir);
    expect(newest).toContain('new.log');
    const tail = tailLog(newest);
    expect(tail).toHaveLength(40);
    expect(tail[tail.length - 1]).toBe('line49');
  });

  it('returns nothing for a run with no directory', () => {
    expect(newestLogFile(join(tmpdir(), 'console-sandbox-missing'))).toBeUndefined();
    expect(tailLog(undefined)).toEqual([]);
  });
});
