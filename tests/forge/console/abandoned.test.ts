import { describe, expect, it } from 'vitest';

import {
  ABANDONED_SILENCE_MS, abandonedVerdict, worktreeIsSafeToLeave,
  type WorktreeState,
} from '../../../src/forge/console/abandoned.js';
import type { Lane, QueueItem } from '../../../src/shared/console-model.js';

/**
 * Aaron, 2026-09-12: "if a lane is stuck it needs to self heal ... what would my options
 * even be? leave it and just let it hold up the entire system? what a useless question."
 *
 * Three lanes sat blocked for 70, 72 and 83 hours with no process, no queue row, and a
 * worktree that was clean and pushed or gone. The board's only exit for each was Kill,
 * which is irreversible, so it raised a confirm card and asked every ten minutes whether
 * to destroy something already destroyed.
 *
 * Both halves are pinned here: a lane with nothing alive behind it goes on its own, and a
 * lane with anything at all behind it stays and says what kept it.
 */

const NOW = 1_789_260_000_000;
const LONG_AGO = NOW - 70 * 60 * 60_000;

function lane(patch: Partial<Lane> = {}): Lane {
  return {
    id: '2026-09-09-readable-pr-rule', state: 'blocked', ticket: null, title: null,
    retiredAt: null, since: LONG_AGO,
    live: { alive: false, pid: null, lastEventAt: LONG_AGO, checkedAt: NOW },
    ...patch,
  } as unknown as Lane;
}

function queueRow(runKey: string, state = 'running'): QueueItem {
  return { id: 'Q-1', runKey, state, ticket: 'BBZ-1' } as unknown as QueueItem;
}

const CLEAN: WorktreeState = { exists: true, dirty: false, unpushed: false };
const GONE: WorktreeState = { exists: false, dirty: false, unpushed: false };

function verdict(patch: Partial<Parameters<typeof abandonedVerdict>[0]> = {}) {
  return abandonedVerdict({ lane: lane(), now: NOW, queue: [], worktree: CLEAN, ...patch });
}

describe('a lane with nothing alive behind it', () => {
  it('leaves the board on its own, with the reason recorded', () => {
    const out = verdict();
    expect(out.abandoned).toBe(true);
    expect(out.abandoned === true && out.why).toContain('no process');
    expect(out.abandoned === true && out.why).toContain('nothing in the queue');
  });

  it('goes when its worktree is not there at all', () => {
    expect(verdict({ worktree: GONE }).abandoned).toBe(true);
  });

  it('says how long it was silent, so the row explains itself later', () => {
    const out = verdict();
    expect(out.abandoned === true && out.why).toMatch(/silent \d+h/);
  });
});

describe('a lane with anything behind it stays, and says what kept it', () => {
  it('stays while a process is running — the case the no-kill rule exists for', () => {
    const out = verdict({ lane: lane({ live: { alive: true, pid: 123, lastEventAt: LONG_AGO, checkedAt: NOW } } as Partial<Lane>) });
    expect(out.abandoned).toBe(false);
    expect(out.abandoned === false && out.keptBecause).toContain('still running');
  });

  it('stays while the queue still holds it', () => {
    const out = verdict({ queue: [queueRow('2026-09-09-readable-pr-rule', 'review')] });
    expect(out.abandoned === false && out.keptBecause).toContain('review');
  });

  it('stays when its worktree has uncommitted work', () => {
    const out = verdict({ worktree: { exists: true, dirty: true, unpushed: false } });
    expect(out.abandoned === false && out.keptBecause).toContain('uncommitted');
  });

  it('stays when its worktree has commits nobody pushed', () => {
    const out = verdict({ worktree: { exists: true, dirty: false, unpushed: true } });
    expect(out.abandoned === false && out.keptBecause).toContain('never pushed');
  });

  /**
   * The first draft of this rule kept a lane whose worktree could not be read, on the
   * fail-closed reasoning that an unreadable tree might hold anything. That was wrong for
   * this action: retiring writes one row and never touches a tree, so nothing can be lost
   * by it -- and treating unknown as unsafe would have kept every lane whose registry row
   * was already gone, which is every lane this exists to clear.
   */
  it('goes when no worktree is on record, because retiring cannot lose one', () => {
    const out = verdict({ worktree: null });
    expect(out.abandoned).toBe(true);
    expect(out.abandoned === true && out.why).toContain('no worktree is on record');
  });

  it('stays when it went quiet only moments ago', () => {
    const recent = NOW - (ABANDONED_SILENCE_MS - 1);
    const out = verdict({ lane: lane({ live: { alive: false, pid: null, lastEventAt: recent, checkedAt: NOW } } as Partial<Lane>) });
    expect(out.abandoned === false && out.keptBecause).toContain('too recently');
  });

  it('does nothing to a lane that has already left', () => {
    const out = verdict({ lane: lane({ retiredAt: NOW - 1000 } as Partial<Lane>) });
    expect(out.abandoned === false && out.keptBecause).toContain('already left');
  });
});

describe('worktreeIsSafeToLeave', () => {
  it('is true for a clean pushed tree and for one that is gone', () => {
    expect(worktreeIsSafeToLeave(CLEAN)).toBe(true);
    expect(worktreeIsSafeToLeave(GONE)).toBe(true);
  });

  it('is false for anything unsaved, which is the courtesy it exists for', () => {
    expect(worktreeIsSafeToLeave({ exists: true, dirty: true, unpushed: false })).toBe(false);
    expect(worktreeIsSafeToLeave({ exists: true, dirty: false, unpushed: true })).toBe(false);
  });

  it('is true when nothing is on record, since retiring touches no tree at all', () => {
    expect(worktreeIsSafeToLeave(null)).toBe(true);
  });
});

describe('the three lanes this was written for', () => {
  const cases = [
    { id: '2026-09-09-forge-compaction-aware-warden', hours: 70, worktree: CLEAN },
    { id: '2026-09-09-readable-pr-rule-flightdeck', hours: 72, worktree: GONE },
    { id: 'queue-BBZ-123-Q-34ddf8a4', hours: 83, worktree: CLEAN },
  ];

  for (const each of cases) {
    it(`clears ${each.id} without asking anyone`, () => {
      const at = NOW - each.hours * 60 * 60_000;
      const out = abandonedVerdict({
        lane: lane({ id: each.id, since: at, live: { alive: false, pid: null, lastEventAt: at, checkedAt: NOW } } as Partial<Lane>),
        now: NOW, queue: [], worktree: each.worktree,
      });
      expect(out.abandoned).toBe(true);
    });
  }
});
