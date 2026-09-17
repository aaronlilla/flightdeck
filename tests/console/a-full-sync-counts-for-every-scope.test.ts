import { describe, expect, it } from 'vitest';

import { runSummary, runForScope } from '../../src/console/sync-text.js';
import type { SyncRunRecord } from '../../src/shared/sync-contract.js';

/**
 * A scope covered by a full sync does not report that it has never synced.
 *
 * Aaron, 2026-09-13, live board: the header read `THE BOARD never synced`. The server's
 * own record held a completed full sync -- nine stages, every one ok -- from earlier the
 * same day. A full sync is the one that covers every scope, and each card read only the
 * run filed under its own name, so the sync that covered all of them counted for none.
 *
 * Not stale data again. The record was right there and the screen contradicted it, which
 * is the shape of every board defect found this session.
 */
function run(scope: string, ok: boolean, startedAt: number): SyncRunRecord {
  return {
    scope, id: `run-${scope}`, startedAt, ok,
    stages: [{ name: 'stop-workers', status: 'ok', startedAt, endedAt: startedAt + 1, counts: {} }],
  } as unknown as SyncRunRecord;
}

describe('the run a scope card reads', () => {
  it('prefers the scope\'s own run', () => {
    const runs = { lanes: run('lanes', true, 200), full: run('full', true, 100) };
    expect(runForScope(runs, 'lanes')?.scope).toBe('lanes');
  });

  it('falls back to the full sync that covered it', () => {
    const runs = { full: run('full', true, 100) };
    expect(runForScope(runs, 'lanes')?.scope).toBe('full');
    expect(runSummary(runForScope(runs, 'lanes'))).not.toMatch(/never synced/);
  });

  // Every scope the board renders a card for, so adding a card cannot quietly reintroduce
  // the claim for one of them.
  for (const scope of ['lanes', 'inbox', 'queue', 'machine', 'sessions']) {
    it(`counts a full sync for ${scope}`, () => {
      expect(runSummary(runForScope({ full: run('full', true, 100) }, scope))).toMatch(/synced ok/);
    });
  }

  it('still says never synced when nothing has run at all', () => {
    expect(runSummary(runForScope({}, 'lanes'))).toMatch(/never synced/);
  });

  // A full sync that failed is not evidence this scope is fine. It is still the newest
  // thing that touched the scope, so it is what the card reports -- as a failure.
  it('reports a failed full sync as the failure it was', () => {
    const failed = { ...run('full', false, 100), ok: false } as SyncRunRecord;
    expect(runSummary(runForScope({ full: failed }, 'lanes'))).not.toMatch(/never synced|synced ok/);
  });

  it('never lets an older full sync outrank the scope\'s own newer run', () => {
    const runs = { lanes: run('lanes', true, 300), full: run('full', true, 100) };
    expect(runForScope(runs, 'lanes')?.startedAt).toBe(300);
  });

  it('does not answer for the full card with itself twice over', () => {
    expect(runForScope({ full: run('full', true, 100) }, 'full')?.scope).toBe('full');
  });
});
