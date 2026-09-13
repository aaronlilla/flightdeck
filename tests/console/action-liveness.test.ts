import { describe, expect, it } from 'vitest';

import { laneActionLiveness, queueActionLiveness } from '../../src/console/actionLiveness.js';
import type { Lane, QueueItem } from '../../src/shared/console-model.js';

/**
 * The last two kinds in `LIVENESS_RULES` that carried a rule and no seam.
 *
 * What this catches, in the words Aaron used on 2026-09-12: a board that is "constantly
 * dead or old information". A tile offering Merge on a pull request that merged an hour
 * ago is not a broken button — it is the board telling somebody to do a thing already
 * done.
 */

function lane(patch: Partial<Lane> = {}): Lane {
  return {
    id: 'l1', state: 'done', retiredAt: null, pr: null, mergeable: null,
    live: { alive: false, pid: null, lastEventAt: 0, checkedAt: 0 },
    ...patch,
  } as unknown as Lane;
}

function item(patch: Partial<QueueItem> = {}): QueueItem {
  return { id: 'Q-1', state: 'review', pr: null, ...patch } as unknown as QueueItem;
}

describe('a lane tile button', () => {
  it('offers Merge while the pull request is open and mergeable', () => {
    const out = laneActionLiveness({ lane: lane({ pr: { no: 1, merged: false } as Lane['pr'], mergeable: { ok: true } }), cmd: 'merge' });
    expect(out.live).toBe(true);
  });

  it('does not offer Merge on a pull request that already merged', () => {
    const out = laneActionLiveness({ lane: lane({ pr: { no: 1, merged: true } as Lane['pr'] }), cmd: 'merge' });
    expect(out.live).toBe(false);
    expect(out.live === false && out.why).toContain('already merged');
  });

  it('does not offer Merge when there is no pull request at all', () => {
    expect(laneActionLiveness({ lane: lane(), cmd: 'merge' }).live).toBe(false);
  });

  it('passes on the server own reason when Merge is refused', () => {
    const out = laneActionLiveness({
      lane: lane({ pr: { no: 1, merged: false } as Lane['pr'], mergeable: { ok: false, why: 'checks are still running' } }),
      cmd: 'merge',
    });
    expect(out.live === false && out.why).toBe('checks are still running');
  });

  it('does not offer Kill when nothing is running to stop', () => {
    const out = laneActionLiveness({ lane: lane({ state: 'blocked' }), cmd: 'kill' });
    expect(out.live === false && out.why).toContain('nothing is running');
  });

  it('offers Kill while a process is running', () => {
    const running = lane({ live: { alive: true, pid: 9, lastEventAt: 0, checkedAt: 0 } } as Partial<Lane>);
    expect(laneActionLiveness({ lane: running, cmd: 'kill' }).live).toBe(true);
  });

  /**
   * Resume on a lane with no process is LIVE. Resuming relaunches from scratch, so the
   * absence of a process is the reason to press it rather than a reason it would fail.
   */
  it('offers Resume on a lane with no process, because that is what Resume is for', () => {
    expect(laneActionLiveness({ lane: lane({ state: 'parked' }), cmd: 'resume' }).live).toBe(true);
  });

  /**
   * Navigation is checked on a RETIRED lane on purpose. On a live one it would pass with
   * or without its own branch, because everything unrecognised falls through to live —
   * so the first version of this case proved nothing and stayed green when the branch was
   * deleted. A retired lane is where the branch decides: everything else about it is
   * dead, and moving to another screen still is not.
   */
  it('keeps navigation live even on a lane that has left the board', () => {
    const gone = lane({ retiredAt: 1 } as Partial<Lane>);
    for (const cmd of ['watch', 'settings', 'blockers', 'queue', 'open-url:https://example.test']) {
      expect(laneActionLiveness({ lane: gone, cmd }).live, cmd).toBe(true);
    }
  });

  it('keeps navigation live on an ordinary lane too', () => {
    expect(laneActionLiveness({ lane: lane(), cmd: 'watch' }).live).toBe(true);
  });

  it('offers only Unretire once a lane has left the board', () => {
    const gone = lane({ retiredAt: 1 } as Partial<Lane>);
    expect(laneActionLiveness({ lane: gone, cmd: 'unretire' }).live).toBe(true);
    expect(laneActionLiveness({ lane: gone, cmd: 'resume' }).live).toBe(false);
  });
});

describe('a queue row button', () => {
  it('offers Merge only while the row is waiting to merge', () => {
    expect(queueActionLiveness(item(), 'merge').live).toBe(true);
    const running = queueActionLiveness(item({ state: 'running' }), 'merge');
    expect(running.live === false && running.why).toContain('not waiting to merge');
  });

  it('does not offer Merge on a row whose pull request already merged', () => {
    const out = queueActionLiveness(item({ pr: { no: 1, merged: true } as QueueItem['pr'] }), 'merge');
    expect(out.live === false && out.why).toContain('already merged');
  });

  it('does not offer Retry on a row that is already working', () => {
    expect(queueActionLiveness(item({ state: 'running' }), 'retry').live).toBe(false);
    expect(queueActionLiveness(item({ state: 'planning' }), 'retry').live).toBe(false);
  });

  it('offers Retry on a parked or failed row', () => {
    expect(queueActionLiveness(item({ state: 'parked' }), 'retry').live).toBe(true);
    expect(queueActionLiveness(item({ state: 'failed' }), 'retry').live).toBe(true);
  });

  it('does not offer Remove on a row that is running', () => {
    const out = queueActionLiveness(item({ state: 'running' }), 'remove');
    expect(out.live === false && out.why).toContain('stop it before removing');
  });
});
