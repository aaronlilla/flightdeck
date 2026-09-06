import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { computeJournal, jidFor, textFor, type ActionsLedgerRow } from '../../../src/forge/console/journal-route.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-journal-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

describe('textFor', () => {
  it('renders a run.started row', () => {
    expect(textFor({ id: '1', seq: 1, at: 1, version: 1, event: 'run.started', actor: 'runner', run: 'alpha' })).toBe('alpha started');
  });

  it('falls back to the event name for a kind with no table entry', () => {
    expect(textFor({ id: '1', seq: 1, at: 1, version: 1, event: 'note', actor: 'runner', run: 'alpha' })).toBe('note (alpha)');
    expect(textFor({ id: '1', seq: 1, at: 1, version: 1, event: 'note', actor: 'runner' })).toBe('note');
  });
});

describe('computeJournal', () => {
  it('renders every row newest-first, from a real journal fixture', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner', verdict: 'done' });
    journal.close();
    const fleet = replay(path);
    const result = computeJournal(fleet.events, []);
    expect(result.total).toBe(2);
    expect(result.rows[0]!.text).toBe('alpha finished (done)');
    expect(result.rows[1]!.text).toBe('alpha started');
  });

  it('filters by run and since, and caps at limit', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.started', run: 'beta', actor: 'runner' });
    journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Bash' });
    journal.close();
    const fleet = replay(path);

    const byRun = computeJournal(fleet.events, [], { run: 'alpha' });
    expect(byRun.total).toBe(2);

    const limited = computeJournal(fleet.events, [], { limit: 1 });
    expect(limited.rows).toHaveLength(1);
    expect(limited.total).toBe(3);
  });

  it('marks a row undoable/undone from the actions ledger, by jid', () => {
    const { path, journal } = tempJournal();
    const row = journal.append({ event: 'run.paused', run: 'alpha', actor: 'console' });
    journal.close();
    const fleet = replay(path);
    const jid = jidFor(row);
    const ledger: ActionsLedgerRow[] = [
      { jid, ts: row.at, kind: 'pause', run: 'alpha', text: 'paused alpha', undo: { kind: 'resume' }, undoneAt: undefined },
    ];
    const result = computeJournal(fleet.events, ledger);
    const entry = result.rows.find((r) => r.jid === jid)!;
    expect(entry.undoable).toBe(true);
    expect(entry.undone).toBe(false);
  });
});
