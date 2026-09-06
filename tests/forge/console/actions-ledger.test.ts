import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ActionsLedger, recordAction } from '../../../src/forge/console/actions-ledger.js';

function tempJournal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-ledger-'));
  return join(dir, 'fleet.jsonl');
}

describe('recordAction', () => {
  it('writes a decision.made row and a matching ledger row sharing one jid', () => {
    const journalPath = tempJournal();
    const ledger = new ActionsLedger(join(join(journalPath, '..'), 'actions.jsonl'));

    const { jid } = recordAction(journalPath, ledger, {
      kind: 'kill', run: 'alpha', text: 'kill requested: over budget', undo: null, extra: { reason: 'over budget' },
    });

    const journalLines = readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(journalLines).toHaveLength(1);
    expect(journalLines[0]).toMatchObject({
      id: jid, event: 'decision.made', actor: 'console', action: 'kill', run: 'alpha',
    });

    const row = ledger.get(jid);
    expect(row).toMatchObject({ jid, kind: 'kill', run: 'alpha', undo: null });
    expect(row?.undoneAt).toBeUndefined();
  });

  it('reports undoable rows as such', () => {
    const journalPath = tempJournal();
    const ledger = new ActionsLedger(join(join(journalPath, '..'), 'actions.jsonl'));
    const { jid } = recordAction(journalPath, ledger, {
      kind: 'pause', run: 'beta', text: 'paused', undo: { kind: 'resume-run', payload: { run: 'beta' } },
    });
    const row = ledger.get(jid);
    expect(row?.undo).toEqual({ kind: 'resume-run', payload: { run: 'beta' } });
  });
});

describe('ActionsLedger.markUndone', () => {
  it('appends a second row for the same jid rather than mutating the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ledger-'));
    const ledger = new ActionsLedger(join(dir, 'actions.jsonl'));
    ledger.append({ jid: 'j1', ts: 1, kind: 'pause', run: 'alpha', text: 'paused', undo: { kind: 'resume-run', payload: {} } });

    const updated = ledger.markUndone('j1');

    expect(updated?.undoneAt).toBeDefined();
    expect(ledger.all()).toHaveLength(2);
    expect(ledger.get('j1')?.undoneAt).toBeDefined();
  });

  it('refuses to undo a jid twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ledger-'));
    const ledger = new ActionsLedger(join(dir, 'actions.jsonl'));
    ledger.append({ jid: 'j1', ts: 1, kind: 'pause', run: 'alpha', text: 'paused', undo: { kind: 'resume-run', payload: {} } });
    ledger.markUndone('j1');

    expect(ledger.markUndone('j1')).toBeUndefined();
  });

  it('returns undefined for an unknown jid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ledger-'));
    const ledger = new ActionsLedger(join(dir, 'actions.jsonl'));
    expect(ledger.markUndone('nope')).toBeUndefined();
  });
});
