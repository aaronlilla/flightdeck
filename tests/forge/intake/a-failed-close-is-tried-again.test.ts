import { describe, expect, it, vi } from 'vitest';

import { retryOpenPrCloses } from '../../../src/forge/intake/queue.js';
import type { QueueItem } from '../../../src/shared/console-model.js';

/**
 * A pull request the console merged gets closed, even if GitHub was down at the time.
 *
 * The squash pushes a new commit to the base, so GitHub never sees the branch inside it
 * and never closes the pull request itself. The merge therefore closes it explicitly --
 * and on 2026-09-13 that call hit a GitHub outage:
 *
 *   02:05:43 queue.pr-close-failed  pr: 159
 *   error: API call failed: GraphQL: Something went wrong while executing your query
 *
 * The merge was correct, the close was correct, and the failure was recorded once and
 * never tried again. The board went on reading "Draft PR #159 is waiting for your Merge"
 * for a ticket that had landed an hour earlier, which is the board staleness Aaron
 * reported, produced by the console's own merge.
 *
 * Retrying is safe: closing a pull request that is already closed changes nothing.
 */
function merged(id: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id, source: 'ticket', input: 'ABC-1', ticket: 'ABC-1', repo: 'owner/name',
    briefPath: null, branch: 'feature/abc-1', worktreePath: null, base: 'develop',
    state: 'done', reason: null, runKey: null, journalIds: [], createdAt: 1, updatedAt: 1,
    mergedBy: 'queue', mergedAt: 10,
    pr: { no: 9, url: 'https://example.test/9', draft: true, closed: false, merged: false },
    ...over,
  } as unknown as QueueItem;
}

describe('closing a pull request the queue already merged', () => {
  it('tries again for one the queue merged and left open', async () => {
    const closePr = vi.fn(async (_input: { repo: string; pr: number; comment: string }) => ({ ok: true }));
    const closed = await retryOpenPrCloses([merged('Q-1')], { closePr });
    expect(closePr).toHaveBeenCalledTimes(1);
    expect(closePr.mock.calls[0]?.[0] as unknown as Record<string, unknown>).toMatchObject({ repo: 'owner/name', pr: 9 });
    expect(closed).toEqual(['Q-1']);
  });

  it('leaves alone one the queue never merged', async () => {
    const closePr = vi.fn(async (_input: { repo: string; pr: number; comment: string }) => ({ ok: true }));
    await retryOpenPrCloses([merged('Q-1', { mergedBy: undefined, mergedAt: undefined } as never)], { closePr });
    expect(closePr).not.toHaveBeenCalled();
  });

  it('leaves alone one whose pull request is already closed', async () => {
    const closePr = vi.fn(async (_input: { repo: string; pr: number; comment: string }) => ({ ok: true }));
    await retryOpenPrCloses([merged('Q-1', { pr: { no: 9, url: 'u', closed: true } as never })], { closePr });
    expect(closePr).not.toHaveBeenCalled();
  });

  it('leaves alone one GitHub already marked merged', async () => {
    const closePr = vi.fn(async (_input: { repo: string; pr: number; comment: string }) => ({ ok: true }));
    await retryOpenPrCloses([merged('Q-1', { pr: { no: 9, url: 'u', merged: true } as never })], { closePr });
    expect(closePr).not.toHaveBeenCalled();
  });

  it('says which merge commit it landed as, when the item recorded one', async () => {
    const closePr = vi.fn(async (_input: { repo: string; pr: number; comment: string }) => ({ ok: true }));
    await retryOpenPrCloses([merged('Q-1', { mergeSha: 'abc1234' } as never)], { closePr });
    expect(String((closePr.mock.calls[0]?.[0] as unknown as { comment: string }).comment)).toContain('abc1234');
  });

  // Another outage must not turn into a thrown error that stops the sweep: the next
  // items still get their turn, and this one is tried again on the tick after.
  it('carries on past one that fails, and reports only what it closed', async () => {
    const closePr = vi.fn(async ({ pr }: { repo: string; pr: number; comment: string }) => (pr === 9 ? { ok: false, reason: 'still down' } : { ok: true }));
    const closed = await retryOpenPrCloses([merged('Q-1'), merged('Q-2', { pr: { no: 10, url: 'u' } as never })], { closePr });
    expect(closePr).toHaveBeenCalledTimes(2);
    expect(closed).toEqual(['Q-2']);
  });

  it('carries on past one that throws', async () => {
    const closePr = vi.fn(async ({ pr }: { repo: string; pr: number; comment: string }): Promise<{ ok: boolean; reason?: string }> => {
      if (pr === 9) throw new Error('socket hang up');
      return { ok: true };
    });
    const closed = await retryOpenPrCloses([merged('Q-1'), merged('Q-2', { pr: { no: 10, url: 'u' } as never })], { closePr });
    expect(closed).toEqual(['Q-2']);
  });

  it('does nothing at all with no closer wired, rather than throwing', async () => {
    await expect(retryOpenPrCloses([merged('Q-1')], {})).resolves.toEqual([]);
  });

  // 2026-09-23: GitHub answered "can't be closed because it was already merged" for #188
  // and #189 and the sweep retried every tick, ~41,600 times, until the account hit its
  // GraphQL rate limit. Already merged or closed is the goal state: record it as closed.
  it('counts an "already merged" refusal as closed, so it is never retried', async () => {
    const append = vi.fn();
    const closePr = vi.fn(async () => ({ ok: false, reason: "X Pull request o/n#188 can't be closed because it was already merged\n" }));
    const closed = await retryOpenPrCloses([merged('Q-1')], { closePr, append } as never);
    expect(closed).toEqual(['Q-1']);
    expect(append).not.toHaveBeenCalled();
  });
});
