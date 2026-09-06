import type { Message } from '../../shared/console-model.js';

export function seedThread(): Message[] {
  const now = Date.now();
  return [
    {
      k: 'm1', type: 'event', text: 'BBZ-118 parked -- needs an answer', ts: now - 8 * 60_000,
      source: 'system', lane: 'BBZ-118', verifiedAt: now - 8 * 60_000,
    },
    {
      k: 'm2', type: 'question', text: 'the migration column should be NOT NULL or nullable with a backfill job?',
      ts: now - 8 * 60_000, source: 'BBZ-118', lane: 'BBZ-118', askKey: 'ask-bbz-118',
      opts: ['NOT NULL', 'nullable + backfill', 'abort the migration'],
    },
    {
      k: 'm3', type: 'reply', text: 'FLT-204 is running $1.30/min over its $8 cap and has failed twice. Recommend killing it.',
      ts: now - 5 * 60_000, source: 'conductor',
      btns: [{ label: 'Kill FLT-204', cmd: 'kill FLT-204', cls: 'destroy' }],
    },
  ];
}
