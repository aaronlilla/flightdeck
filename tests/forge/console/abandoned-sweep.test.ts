import { describe, expect, it, vi } from 'vitest';

import { sweepAbandonedLanes } from '../../../src/forge/console/abandoned-sweep.js';
import type { Lane, QueueItem } from '../../../src/shared/console-model.js';

const NOW = 1_789_260_000_000;
const LONG_AGO = NOW - 70 * 60 * 60_000;

function lane(id: string, patch: Partial<Lane> = {}): Lane {
  return {
    id, state: 'blocked', ticket: null, title: null, retiredAt: null, since: LONG_AGO,
    live: { alive: false, pid: null, lastEventAt: LONG_AGO, checkedAt: NOW },
    ...patch,
  } as unknown as Lane;
}

const CLEAN = { exists: true, dirty: false, unpushed: false };

function sweep(patch: Partial<Parameters<typeof sweepAbandonedLanes>[0]> = {}) {
  const retire = vi.fn();
  const result = sweepAbandonedLanes({
    lanesAll: () => [lane('a')], queue: () => [], worktreeFor: () => CLEAN,
    retire, now: () => NOW, ...patch,
  });
  return { result, retire };
}

describe('the sweep', () => {
  it('clears a lane with nothing alive behind it, and says why on the row', () => {
    const { result, retire } = sweep();
    expect(result.cleared.map((row) => row.id)).toEqual(['a']);
    expect(retire).toHaveBeenCalledWith('a', expect.stringContaining('no process'));
  });

  it('keeps one the queue still holds, and records what kept it', () => {
    const { result, retire } = sweep({ queue: () => [{ id: 'Q-1', runKey: 'a', state: 'review' } as unknown as QueueItem] });
    expect(result.cleared).toEqual([]);
    expect(result.kept[0]?.keptBecause).toContain('review');
    expect(retire).not.toHaveBeenCalled();
  });

  it('survives a worktree read that throws, and still clears the lane', () => {
    // Retiring touches no tree, so a failed read is missing evidence for the courtesy
    // check rather than a reason to keep the lane. What matters is that the throw does
    // not take the sweep down with it.
    const { result, retire } = sweep({ worktreeFor: () => { throw new Error('git is not there'); } });
    expect(result.cleared.map((row) => row.id)).toEqual(['a']);
    expect(retire).toHaveBeenCalledWith('a', expect.stringContaining('no worktree is on record'));
  });

  it('keeps one whose worktree still holds unpushed work', () => {
    const { result, retire } = sweep({ worktreeFor: () => ({ exists: true, dirty: false, unpushed: true }) });
    expect(retire).not.toHaveBeenCalled();
    expect(result.kept[0]?.keptBecause).toContain('never pushed');
  });

  it('judges each lane on its own, so one that stays does not hold back one that goes', () => {
    const { result } = sweep({
      lanesAll: () => [lane('stays', { live: { alive: true, pid: 7, lastEventAt: LONG_AGO, checkedAt: NOW } } as Partial<Lane>), lane('goes')],
    });
    expect(result.cleared.map((row) => row.id)).toEqual(['goes']);
    expect(result.kept.map((row) => row.id)).toEqual(['stays']);
  });

  it('does not report a lane already off the board as kept', () => {
    const { result } = sweep({ lanesAll: () => [lane('gone', { retiredAt: NOW - 1000 } as Partial<Lane>)] });
    expect(result.kept).toEqual([]);
    expect(result.cleared).toEqual([]);
  });

  it('leaves a lane on the board when the write fails, so the next pass tries again', () => {
    const { result } = sweep({ retire: () => { throw new Error('disk full'); } });
    expect(result.cleared).toEqual([]);
    expect(result.kept[0]?.keptBecause).toContain('could not be written');
  });

  it('tells the caller about every lane that stayed', () => {
    const onKept = vi.fn();
    sweep({ queue: () => [{ id: 'Q-1', runKey: 'a', state: 'running' } as unknown as QueueItem], onKept });
    expect(onKept).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.stringContaining('running'));
  });
});
