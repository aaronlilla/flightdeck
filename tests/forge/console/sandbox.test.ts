import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChainPacketState } from '../../../src/forge/chain.js';
import { classifyLogSeverity, computeSandbox, newestLogFile, tailLog, tailLogWithSeverity } from '../../../src/forge/console/sandbox.js';

describe('computeSandbox', () => {
  it('is null with no provision row and no registry row', () => {
    expect(computeSandbox('alpha', new Map(), undefined)).toBeNull();
  });

  it('carries path/branch from the chain provision row, pid/session from the registry, and the real region/instance facts', () => {
    const chain = new Map<string, ChainPacketState>([
      ['p1', { packetId: 'p1', launched: { runKey: 'alpha' }, provisioned: { worktreePath: 'w', branch: 'feature/ab-1' } }],
    ]);
    const result = computeSandbox('alpha', chain, { goal: 'alpha', cwd: 'w', briefPath: 'b.md', pid: 42, startedAt: 0, sessionId: 's1' });
    expect(result).toEqual({
      id: 'alpha', path: 'w', branch: 'feature/ab-1', pid: 42, sessionId: 's1',
      region: 'local', instanceType: `${process.platform}/${process.arch}`,
    });
  });
});

describe('classifyLogSeverity', () => {
  it('reads an error line as error', () => {
    expect(classifyLogSeverity('2026-09-06T00:00:00Z build failed: exit 1')).toBe('error');
  });
  it('reads a retry line as retry', () => {
    expect(classifyLogSeverity('retrying npm install (attempt 2)')).toBe('retry');
  });
  it('reads a build/progress line as progress', () => {
    expect(classifyLogSeverity('installing dependencies…')).toBe('progress');
  });
  it('falls back to info for anything else', () => {
    expect(classifyLogSeverity('sandbox ready')).toBe('info');
  });
});

describe('tailLogWithSeverity', () => {
  it('tags every tailed line with its severity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'console-sandbox-sev-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'run.log');
    writeFileSync(file, ['sandbox ready', 'retrying git push', 'build failed: exit 1'].join('\n'));
    expect(tailLogWithSeverity(file)).toEqual([
      { text: 'sandbox ready', severity: 'info' },
      { text: 'retrying git push', severity: 'retry' },
      { text: 'build failed: exit 1', severity: 'error' },
    ]);
  });

  it('is empty for no log file', () => {
    expect(tailLogWithSeverity(undefined)).toEqual([]);
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
