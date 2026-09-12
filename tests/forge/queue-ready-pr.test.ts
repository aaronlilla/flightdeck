/**
 * Item 16, 2026-09-12: the wire between the queue's review hop and the GitHub writes.
 * A review found two body-destroying defects here that were green because nothing
 * tested this function -- the only `commentPr` in the suite was a no-op stub.
 */
import { describe, expect, it } from 'vitest';

import { queueReadyPrWithPrediction } from '../../src/forge/queue-wire.js';
import type { QueueItem } from '../../src/shared/console-model.js';

const item = { id: 'Q-1', repo: 'owner/name' } as QueueItem;
const pr = { no: 7, url: 'https://github.com/owner/name/pull/7' };

describe('queueReadyPrWithPrediction', () => {
  it('marks ready, then comments, in that order', async () => {
    const calls: string[] = [];
    const run = queueReadyPrWithPrediction({
      async readyPr() { calls.push('ready'); return { returncode: 0, stderr: '' }; },
      async commentPr() { calls.push('comment'); return { returncode: 0, stderr: '' }; },
    });
    const outcome = await run({ item, pr, prediction: 'p' });
    expect(calls).toEqual(['ready', 'comment']);
    expect(outcome).toEqual({ readied: true });
  });

  it('throws when marking ready genuinely fails, so the hop journals it', async () => {
    const run = queueReadyPrWithPrediction({
      async readyPr() { return { returncode: 1, stderr: 'HTTP 403 forbidden' }; },
      async commentPr() { return { returncode: 0, stderr: '' }; },
    });
    await expect(run({ item, pr, prediction: 'p' })).rejects.toThrow(/403 forbidden/);
  });

  // Edge: the gate readies and merges on the auto-merge path before this runs, so
  // `gh pr ready` fails on a pull request that is already ready or merged. Treating
  // that as a failure wrote a false row on every successful auto-merge.
  it('treats an already-ready pull request as readied, not a failure', async () => {
    let commented = false;
    const run = queueReadyPrWithPrediction({
      async readyPr() { return { returncode: 1, stderr: 'pull request is not a draft' }; },
      async commentPr() { commented = true; return { returncode: 0, stderr: '' }; },
    });
    expect(await run({ item, pr, prediction: 'p' })).toEqual({ readied: true });
    expect(commented).toBe(true);
  });

  // A closed pull request was never readied, and recording it as ready says it is
  // mergeable when it is not. It still gets the prediction: whoever reopens it wants
  // to know what merging costs (code review, 2026-09-12).
  it('does not call a closed pull request readied, but still comments', async () => {
    let commented = false;
    const run = queueReadyPrWithPrediction({
      async readyPr() {
        return {
          returncode: 1,
          stderr: 'Pull request owner/repo#7 is closed. Only draft pull requests can be marked as "ready for review"',
        };
      },
      async commentPr() { commented = true; return { returncode: 0, stderr: '' }; },
    });
    expect(await run({ item, pr, prediction: 'p' })).toEqual({ readied: false });
    expect(commented).toBe(true);
  });

  // Edge: the pull request IS ready and only the prediction is missing. Throwing here
  // recorded it as still a draft, under an event naming the wrong write.
  it('reports a failed comment without claiming the pull request is still a draft', async () => {
    const run = queueReadyPrWithPrediction({
      async readyPr() { return { returncode: 0, stderr: '' }; },
      async commentPr() { return { returncode: 1, stderr: 'HTTP 422' }; },
    });
    const outcome = await run({ item, pr, prediction: 'p' });
    expect(outcome).toEqual({ readied: true, predictionError: 'HTTP 422' });
  });

  // Edge: an item with no repo has nothing to write to.
  it('does nothing for an item with no repo', async () => {
    let touched = false;
    const run = queueReadyPrWithPrediction({
      async readyPr() { touched = true; return { returncode: 0, stderr: '' }; },
      async commentPr() { touched = true; return { returncode: 0, stderr: '' }; },
    });
    expect(await run({ item: { ...item, repo: null } as QueueItem, pr, prediction: 'p' }))
      .toEqual({ readied: false });
    expect(touched).toBe(false);
  });
});
