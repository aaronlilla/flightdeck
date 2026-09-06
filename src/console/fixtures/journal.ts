import type { JournalEntry } from '../../shared/console-model.js';

export function seedJournal(): JournalEntry[] {
  const now = Date.now();
  return [
    {
      jid: 'J-40220', ts: now - 30 * 60_000, kind: 'caps.set', text: 'daily cap set to 12M tokens',
      actor: 'operator', run: null, undoable: true, undone: false,
    },
    {
      jid: 'J-40219', ts: now - 25 * 60_000, kind: 'cap.enforcement.failed',
      text: 'FLT-204 exceeded its per-run cap and was not auto-paused', actor: 'system', run: 'FLT-204',
      undoable: false, undone: false,
    },
    {
      jid: 'J-40218', ts: now - 20 * 60_000, kind: 'run.paused', text: 'FLT-187 paused',
      actor: 'operator', run: 'FLT-187', undoable: true, undone: false,
    },
  ];
}
