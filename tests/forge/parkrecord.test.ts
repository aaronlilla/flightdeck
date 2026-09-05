/**
 * The cross-process park record, and the PreToolUse hook that has to honour it.
 *
 * The falsifier this guards against: a specimen that only asserts a journal row for a
 * park, never that the run's next tool call is actually denied. `warden.parked` already
 * satisfied that falsifier for the in-process case (B.3.10); this file satisfies it for a
 * park written by a different process than the one holding the session.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearParkRecord, readParkRecord, writeParkRecord } from '../../src/forge/parkrecord.js';
import { buildPreToolUseHook } from '../../src/forge/sdkengine.js';
import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-park-'));
  process.env['FORGE_HOME'] = home;
});

afterEach(() => {
  delete process.env['FORGE_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('the park record', () => {
  it('is absent for a run nobody parked', () => {
    expect(readParkRecord('r1')).toBeUndefined();
  });

  it('is read back exactly as written', () => {
    writeParkRecord('r1', { key: 'warden:idle:r1', reason: 'idle for 300s', at: 1000 });
    expect(readParkRecord('r1')).toEqual({ key: 'warden:idle:r1', reason: 'idle for 300s', at: 1000 });
  });

  it('clears on demand', () => {
    writeParkRecord('r1', { key: 'k', reason: 'r', at: 1 });
    clearParkRecord('r1');
    expect(readParkRecord('r1')).toBeUndefined();
  });
});

describe('the PreToolUse hook, faced with a park record it did not write itself', () => {
  it('denies the very next tool call, not merely a journal row', async () => {
    const journalPath = join(home, 'fleet.jsonl');
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox'));
    const hook = buildPreToolUseHook({
      run: 'r1', goal: 'r1', journal, parked: new Map(), inbox, deliverVia: 'hook',
    });

    // Falsifier check: with no park record, the hook must let the call through.
    const before = await hook({ toolName: 'Bash', input: {}, toolUseId: 't0' });
    expect(before.decision).toBeUndefined();

    writeParkRecord('r1', { key: 'warden:idle:r1', reason: 'idle for 300s', at: Date.now() });
    const verdict = await hook({ toolName: 'Bash', input: {}, toolUseId: 't1' });
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toMatch(/parked by warden/);

    journal.close();
  });
});
