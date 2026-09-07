import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { computeRunThread, computeThread } from '../../../src/forge/console/thread.js';
import type { InboxEntry } from '../../../src/forge/inbox.js';
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

  it('H1.9: collapses a repeated warden.parked storm for one real lane into a single chip', () => {
    const { path, journal } = tempJournal();
    for (let i = 0; i < 20; i += 1) {
      journal.append({ event: 'warden.parked', run: 'queue-BBZ-182', actor: 'warden', signal: 'stale-session' });
    }
    journal.close();
    const fleet = replay(path);

    const result = computeThread([], fleet.events, 10_000);
    const eventMessages = result.messages.filter((m) => m.type === 'event');
    expect(eventMessages).toHaveLength(1);
    expect(eventMessages[0]!.text).toContain('×20');
  });

  it('H1.9: never puts a bare-PID stuck-session row on the rail at all', () => {
    const { path, journal } = tempJournal();
    for (let i = 0; i < 5; i += 1) {
      journal.append({ event: 'warden.parked', run: 'PID:51340', actor: 'warden', signal: 'stale-session' });
    }
    journal.close();
    const fleet = replay(path);

    const result = computeThread([], fleet.events, 10_000);
    expect(result.messages.filter((m) => m.type === 'event')).toHaveLength(0);
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

  it('surfaces a run\'s open inbox ask as an answerable question card, not just a plate', () => {
    // The board's needs-you plate and the rail's "Question" card (with clickable option
    // buttons) read from two different places: the plate reads `lane.question` off
    // /lanes, but the rail's card only ever renders a persisted `type: 'question'`
    // message -- and nothing wrote one for a live parked run. An operator staring at
    // the rail saw no way to click an answer; they had to already know to type
    // `answer <key> <text>` into the composer by hand.
    const entry: InboxEntry = {
      key: 'ask-1', question: 'Probe: continue to the end?', options: ['Yes', 'No'],
      kind: 'question', runs: ['probe-1'], goals: ['probe-1'], asked: 1, at: 2_000,
      disposition: 'park',
    };
    const result = computeThread([], [], 10_000, [entry]);
    const question = result.messages.find((m) => m.type === 'question');
    expect(question).toBeDefined();
    expect(question?.askKey).toBe('ask-1');
    expect(question?.opts).toEqual(['Yes', 'No']);
    expect(question?.text).toBe('Probe: continue to the end?');
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

  it('renders forge.report as a reply card carrying the run\'s own outcome text', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'forge.report', run: 'alpha', actor: 'worker',
      outcome: 'shipped the fix', done: 'tests pass', leftOff: 'nothing outstanding',
    });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);

    const report = result.messages.find((m) => m.text.includes('shipped the fix'));
    expect(report).toBeDefined();
    expect(report!.type).toBe('reply');
    expect(report!.source).toBe('alpha');
    expect(report!.text).toContain('Done: tests pass');
    expect(report!.text).toContain('Left off: nothing outstanding');
  });

  it('renders forge.done as a reply card carrying its evidence text', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'forge.done', run: 'alpha', actor: 'worker', evidence: 'ran the test suite, green' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);

    const done = result.messages.find((m) => m.text === 'ran the test suite, green');
    expect(done).toBeDefined();
    expect(done!.type).toBe('reply');
    expect(done!.source).toBe('alpha');
  });

  it('renders the run\'s own decision.made rows as receipt cards carrying their jid', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'decision.made', run: 'alpha', actor: 'console', action: 'kill', text: 'kill requested: over budget' });
    journal.close();
    const fleet = replay(path);
    const row = fleet.events[0]!;

    const result = computeRunThread('alpha', fleet.events, []);

    const receipt = result.messages.find((m) => m.type === 'receipt');
    expect(receipt).toBeDefined();
    expect(receipt!.jid).toBe(`J-${row.id.slice(0, 8)}`);
  });
});
