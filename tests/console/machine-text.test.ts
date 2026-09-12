import { describe, expect, it } from 'vitest';

import { humanizeParkReason, stripMachineIds } from '../../src/shared/humanize.js';
import { plainStatus } from '../../src/forge/console/plain.js';

/**
 * Aaron, 2026-09-12: board and strip text must survive the same pass a pull request or a
 * ticket does -- "never unnamed, never confusing, never vague".
 *
 * The stripper knew four id shapes and the live board carried two it had never seen: a
 * dated brief id (`2026-09-09-forge-compaction-aware-warden`), which reached the board
 * body text AND the Needs-you strip whole, and the intake item id on a blocker row
 * (`item:Q-fc2090a8`). A queue row's packet suffix survived too, leaving `-Q-34ddf8a4`
 * standing beside the ticket key that was supposed to replace it.
 */
describe('machine ids the live board was showing on 2026-09-12', () => {
  it('replaces a dated brief id with the words in it', () => {
    const out = stripMachineIds('run 2026-09-09-forge-compaction-aware-warden has produced no event for 149s');
    expect(out).not.toContain('2026-09-09');
    expect(out).toContain('Compaction aware');
  });

  it('replaces one carrying a second-attempt suffix', () => {
    const out = stripMachineIds('2026-09-09-readable-pr-rule-flightdeck-2 finished (parked)');
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(out).toContain('Readable PR rule');
  });

  it('takes the packet suffix with the queue id, not just its head', () => {
    const out = stripMachineIds('rounds.applied (queue-BBZ-123-Q-34ddf8a4)');
    expect(out).not.toContain('34ddf8a4');
    expect(out).toContain('BBZ-123');
  });

  it('replaces an intake item id', () => {
    expect(stripMachineIds('item:Q-fc2090a8')).not.toContain('fc2090a8');
  });

  it('prefers the lane label when the caller has one', () => {
    const out = stripMachineIds('2026-09-09-forge-compaction-aware-warden stops now', {
      labelFor: () => 'BBZ-200',
    });
    expect(out).toContain('BBZ-200');
    expect(out).not.toContain('2026-09-09');
  });

  it('leaves an ordinary date alone', () => {
    expect(stripMachineIds('merged on 2026-09-09 after review')).toContain('2026-09-09');
  });

  it('leaves a date followed by one word alone, which is prose and not an id', () => {
    expect(stripMachineIds('the 2026-09-09 call')).toContain('2026-09-09');
  });
});

describe('a park reason written before the wording changed', () => {
  it('reads as plain words at read time, not as the name of a measurement', () => {
    expect(humanizeParkReason('wall clock: 22.3 h over 3.0 h')).toBe('Running 22.3 h, expected 3.0 h');
  });

  it('rewrites one sitting inside a longer sentence', () => {
    expect(humanizeParkReason('Stuck since 09-10: wall clock: 34.1 h over 3.0 h.'))
      .toBe('Stuck since 09-10: Running 34.1 h, expected 3.0 h.');
  });

  it('leaves a reason that never carried the phrase alone', () => {
    expect(humanizeParkReason('no event for 149s; checking')).toBe('no event for 149s; checking');
  });

  it('still strips a machine id in the same reason', () => {
    const out = humanizeParkReason('run 2026-09-09-forge-compaction-aware-warden: wall clock: 4.0 h over 3.0 h');
    expect(out).toContain('Running 4.0 h, expected 3.0 h');
    expect(out).not.toContain('2026-09-09');
  });
});

/**
 * The board tile reads its reason off `lane.plain`, not off the rail's path, so the
 * rewrite has to be wired in both places. Two tiles carried
 * "Stuck since 09-09: wall clock: 22.3 h over 3.0 h." for three days after the wording
 * changed, because a reason is journaled once and replayed for as long as the lane is up.
 */
describe('the sentence a board tile carries', () => {
  it('says the reason in plain words, whatever the journal recorded', () => {
    const lane = {
      id: '2026-09-09-readable-pr-rule-flightdeck', kind: 'manual', state: 'blocked',
      since: Date.now() - 3 * 60 * 60_000, reason: 'wall clock: 22.3 h over 3.0 h',
      ticket: null, title: null, pr: null, retiredAt: null,
    } as unknown as Parameters<typeof plainStatus>[0];
    const out = plainStatus(lane, { now: Date.now() });
    expect(out).toContain('Running 22.3 h, expected 3.0 h');
    expect(out).not.toContain('wall clock');
  });

  it('still says so when no reason was recorded at all', () => {
    const lane = {
      id: 'x', kind: 'manual', state: 'blocked', since: Date.now(), reason: null,
      ticket: null, title: null, pr: null, retiredAt: null,
    } as unknown as Parameters<typeof plainStatus>[0];
    expect(plainStatus(lane, { now: Date.now() })).toContain('has not been recorded');
  });
});
