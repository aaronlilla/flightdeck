/**
 * Item 16, 2026-09-12: the wire between the queue's review hop and the GitHub writes.
 * A review found two body-destroying defects here that were green because nothing
 * tested this function -- the only `appendPrBody` in the suite was a no-op stub.
 */
import { describe, expect, it } from 'vitest';

import { queueReadyPrWithPrediction } from '../../src/forge/queue-wire.js';
import type { QueueItem } from '../../src/shared/console-model.js';

const item = { id: 'Q-1', repo: 'owner/name' } as QueueItem;
const pr = { no: 7, url: 'https://github.com/owner/name/pull/7' };

describe('queueReadyPrWithPrediction', () => {
  it('marks ready, then appends, in that order', async () => {
    const calls: string[] = [];
    const run = queueReadyPrWithPrediction({
      async readyPr() { calls.push('ready'); return { returncode: 0, stderr: '' }; },
      async appendPrBody() { calls.push('append'); return { returncode: 0, stderr: '' }; },
    });
    const outcome = await run({ item, pr, prediction: 'p' });
    expect(calls).toEqual(['ready', 'append']);
    expect(outcome).toEqual({ readied: true });
  });

  it('throws when marking ready genuinely fails, so the hop journals it', async () => {
    const run = queueReadyPrWithPrediction({
      async readyPr() { return { returncode: 1, stderr: 'HTTP 403 forbidden' }; },
      async appendPrBody() { return { returncode: 0, stderr: '' }; },
    });
    await expect(run({ item, pr, prediction: 'p' })).rejects.toThrow(/403 forbidden/);
  });

  // Edge: the gate readies and merges on the auto-merge path before this runs, so
  // `gh pr ready` fails on a pull request that is already ready or merged. Treating
  // that as a failure wrote a false row on every successful auto-merge.
  it.each(['pull request is not a draft', 'Pull request is already merged'])(
    'treats %s as already ready, not a failure', async (stderr) => {
      let appended = false;
      const run = queueReadyPrWithPrediction({
        async readyPr() { return { returncode: 1, stderr }; },
        async appendPrBody() { appended = true; return { returncode: 0, stderr: '' }; },
      });
      const outcome = await run({ item, pr, prediction: 'p' });
      expect(outcome).toEqual({ readied: true });
      expect(appended).toBe(true);
    },
  );

  // Edge: the pull request IS ready and only the prediction is missing. Throwing here
  // recorded it as still a draft, under an event naming the wrong write.
  it('reports a failed append without claiming the pull request is still a draft', async () => {
    const run = queueReadyPrWithPrediction({
      async readyPr() { return { returncode: 0, stderr: '' }; },
      async appendPrBody() { return { returncode: 1, stderr: 'HTTP 422' }; },
    });
    const outcome = await run({ item, pr, prediction: 'p' });
    expect(outcome).toEqual({ readied: true, predictionError: 'HTTP 422' });
  });

  // Edge: an item with no repo has nothing to write to.
  it('does nothing for an item with no repo', async () => {
    let touched = false;
    const run = queueReadyPrWithPrediction({
      async readyPr() { touched = true; return { returncode: 0, stderr: '' }; },
      async appendPrBody() { touched = true; return { returncode: 0, stderr: '' }; },
    });
    await run({ item: { ...item, repo: null } as QueueItem, pr, prediction: 'p' });
    expect(touched).toBe(false);
  });
});
