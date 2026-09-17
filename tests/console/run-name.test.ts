import { describe, expect, it } from 'vitest';

import { runName } from '../../src/shared/runName.js';
import { laneHeadline, tileHeadlineParts } from '../../src/console/laneVM.js';
import type { Lane } from '../../src/shared/console-model.js';

/**
 * Aaron, 2026-09-12: "Every board item should be a ticket being worked on, never
 * unnamed, never confusing, never vague."
 *
 * Two board tiles both read `Untitled run` on 2026-09-12, so there was no telling which
 * `Resume` belonged to which run. The words were in the run id the whole time; only the
 * date stamp and the product's own name were machine text.
 */

function lane(patch: Partial<Lane>): Lane {
  return { id: 'x', ticket: null, title: null, retiredAt: null, ...patch } as unknown as Lane;
}

describe('runName', () => {
  it('reads the words out of a dated brief id', () => {
    expect(runName('2026-09-09-readable-pr-rule-flightdeck')).toBe('Readable PR rule');
  });

  it('drops the product and its parts, keeping the work', () => {
    expect(runName('2026-09-09-forge-compaction-aware-warden')).toBe('Compaction aware');
  });

  it('drops a second-attempt suffix', () => {
    expect(runName('2026-09-09-readable-pr-rule-flightdeck-2')).toBe('Readable PR rule');
  });

  it('spells an initialism as one', () => {
    expect(runName('2026-09-01-ota-and-ci-checks')).toBe('OTA and CI checks');
  });

  it('answers null for a key, which carries no words', () => {
    expect(runName('S-b9d39bae548707e0')).toBeNull();
    expect(runName('queue-BBZ-169-Q-c578de30')).toBeNull();
    expect(runName('item:Q-fc2090a8')).toBeNull();
  });

  it('answers null rather than an empty string when every word was internal', () => {
    expect(runName('2026-09-09-forge-lane-warden')).toBeNull();
  });

  it('drops a hex chunk sitting inside otherwise readable words', () => {
    expect(runName('2026-09-09-retry-fix-b9d39bae548707e0')).toBe('Retry fix');
  });
});

describe('a board tile always carries a name', () => {
  it('prefers the ticket', () => {
    expect(laneHeadline(lane({ ticket: 'BBZ-169', title: 'Wallet home' })).main).toBe('BBZ-169');
  });

  it('falls to the title when there is no ticket', () => {
    expect(laneHeadline(lane({ title: 'Wallet home screen' })).main).toBe('Wallet home screen');
  });

  it('names an untitled run from its own id rather than saying "Untitled run"', () => {
    const head = laneHeadline(lane({ id: '2026-09-09-readable-pr-rule-flightdeck' }));
    expect(head.main).toBe('Readable PR rule');
  });

  it('tells two untitled runs apart', () => {
    const a = laneHeadline(lane({ id: '2026-09-09-readable-pr-rule-flightdeck' })).main;
    const b = laneHeadline(lane({ id: '2026-09-09-forge-compaction-aware-warden' })).main;
    expect(a).not.toBe(b);
  });

  it('still says something when the id holds no words at all', () => {
    expect(laneHeadline(lane({ id: 'S-b9d39bae548707e0' })).main).toBe('Untitled run');
  });

  it('never renders the raw id as the headline', () => {
    const id = '2026-09-09-readable-pr-rule-flightdeck';
    expect(laneHeadline(lane({ id })).main).not.toContain(id);
  });
});

describe('the board tile, which has its own headline path', () => {
  it('names an untitled run rather than repeating "Untitled run" on every one', () => {
    const a = tileHeadlineParts(lane({ id: '2026-09-09-readable-pr-rule-flightdeck' }));
    const b = tileHeadlineParts(lane({ id: '2026-09-09-forge-compaction-aware-warden' }));
    expect(a.title).toBe('Readable PR rule');
    expect(b.title).toBe('Compaction aware');
    expect(a.title).not.toBe(b.title);
  });

  it('keeps a title the server gave it', () => {
    expect(tileHeadlineParts(lane({ id: '2026-09-09-x-y', title: 'Wallet home' })).title).toBe('Wallet home');
  });

  it('leaves the title empty when the id holds no words, so the tile can fall back', () => {
    expect(tileHeadlineParts(lane({ id: 'S-b9d39bae548707e0' })).title).toBeNull();
  });

  it('never puts the run id in the title', () => {
    const id = '2026-09-09-readable-pr-rule-flightdeck';
    expect(tileHeadlineParts(lane({ id })).title).not.toContain(id);
  });
});

describe('a title that only repeats the ticket key', () => {
  it('is dropped rather than printed under the key it repeats', () => {
    const head = tileHeadlineParts(lane({ id: 'queue-BBZ-123-Q-34ddf8a4', ticket: 'BBZ-123', title: 'BBZ-123' }));
    expect(head.key).toBe('BBZ-123');
    expect(head.title).toBeNull();
  });

  it('keeps a title that says more than the key', () => {
    const head = tileHeadlineParts(lane({ id: 'queue-BBZ-169-Q-c578de30', ticket: 'BBZ-169', title: 'Fix the drop-down (BBZ-169)' }));
    expect(head.title).toBe('Fix the drop-down (BBZ-169)');
  });
});

/**
 * The tile keeps its own copy of the fallback, so the rule has to hold in both places.
 * `tileHeadlineParts` dropping the repeated title is only half the fix: the tile then
 * fell back to the key and printed it a second time anyway.
 */
describe('what the tile finally shows', () => {
  function tileTitle(l: Lane): string | null {
    const head = tileHeadlineParts(l);
    return head.title?.trim() || (head.key ? null : 'Untitled run');
  }

  it('shows nothing in the title line rather than repeating the ticket key', () => {
    expect(tileTitle(lane({ id: 'queue-BBZ-123-Q-34ddf8a4', ticket: 'BBZ-123', title: 'BBZ-123' }))).toBeNull();
  });

  it('shows the run name when there is no ticket', () => {
    expect(tileTitle(lane({ id: '2026-09-09-readable-pr-rule-flightdeck' }))).toBe('Readable PR rule');
  });

  it('says "Untitled run" only when there is no ticket and no words anywhere', () => {
    expect(tileTitle(lane({ id: 'queue-brief-1788955322484' }))).toBe('Untitled run');
  });
});
