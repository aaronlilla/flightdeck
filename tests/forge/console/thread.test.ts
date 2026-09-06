import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { computeRunThread, computeThread } from '../../../src/forge/console/thread.js';
import type { Message } from '../../../src/shared/console-model.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-thread-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

describe('computeThread', () => {
  it('merges persisted rail messages with system chips for matching journal rows', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Bash' });
    journal.close();
    const fleet = replay(path);

    const persisted: Message[] = [
      { k: 'm1', type: 'operator', text: 'pause everything', ts: 1, source: 'operator' },
    ];
    const result = computeThread(persisted, fleet.events, 10_000);
    const kinds = result.messages.map((m) => m.type);
    expect(kinds).toContain('operator');
    expect(kinds).toContain('event');
    // tool.start is not a chip-worthy event: only run.parked shows up as a chip.
    expect(result.messages.filter((m) => m.type === 'event')).toHaveLength(1);
  });

  it('shows no chips for an event before the earliest persisted message', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    fleet.events[0]!.at = 0;

    const persisted: Message[] = [{ k: 'm1', type: 'operator', text: 'hi', ts: 5_000, source: 'operator' }];
    const result = computeThread(persisted, fleet.events, 10_000);
    expect(result.messages.filter((m) => m.type === 'event')).toHaveLength(0);
  });
});

describe('computeRunThread', () => {
  it('renders a run\'s own journal rows as messages, merged with its run-inbox sends', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, [
      { id: 'm1', at: 5, seq: 0, from: 'console', text: 'do the thing' },
    ]);
    expect(result.messages.map((m) => m.text)).toContain('alpha started');
    expect(result.messages.map((m) => m.text)).toContain('do the thing');
  });
});
