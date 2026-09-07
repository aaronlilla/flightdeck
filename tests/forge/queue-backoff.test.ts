/**
 * B.1: three identical consecutive queue.tick-error rows back the tick off to a 10 minute
 * drip, and any change in the error resumes it at once.
 */
import { describe, expect, it } from 'vitest';

import { QueueTickBackoff } from '../../src/forge/queue-backoff.js';

function fakeJournal(): { events: Record<string, unknown>[]; append: (event: Record<string, unknown>) => void } {
  const events: Record<string, unknown>[] = [];
  return { events, append: (event) => { events.push(event); } };
}

describe('QueueTickBackoff', () => {
  it('runs every time until three identical errors in a row', () => {
    const journal = fakeJournal();
    const backoff = new QueueTickBackoff(journal, { now: () => 0 });

    expect(backoff.dueToRun()).toBe(true);
    backoff.onError('cannot reach Jira');
    expect(backoff.isPaused).toBe(false);
    backoff.onError('cannot reach Jira');
    expect(backoff.isPaused).toBe(false);
    expect(journal.events).toHaveLength(0);
  });

  it('pauses on the third identical error and journals queue.paused once', () => {
    const journal = fakeJournal();
    const backoff = new QueueTickBackoff(journal, { now: () => 0 });

    backoff.onError('cannot reach Jira');
    backoff.onError('cannot reach Jira');
    backoff.onError('cannot reach Jira');

    expect(backoff.isPaused).toBe(true);
    expect(journal.events).toHaveLength(1);
    expect(journal.events[0]).toMatchObject({ event: 'queue.paused', reason: 'cannot reach Jira' });
  });

  it('while paused, dueToRun is false until the drip interval has passed', () => {
    let now = 0;
    const journal = fakeJournal();
    const backoff = new QueueTickBackoff(journal, { now: () => now, dripMs: 600_000 });

    backoff.onError('boom');
    backoff.onError('boom');
    backoff.onError('boom');
    expect(backoff.isPaused).toBe(true);

    now += 60_000;
    expect(backoff.dueToRun()).toBe(false);

    now += 600_000;
    expect(backoff.dueToRun()).toBe(true);
  });

  it('a different error message resumes the cadence immediately, journaling nothing new', () => {
    const journal = fakeJournal();
    const backoff = new QueueTickBackoff(journal, { now: () => 0 });

    backoff.onError('boom A');
    backoff.onError('boom A');
    backoff.onError('boom A');
    expect(backoff.isPaused).toBe(true);

    backoff.onError('boom B');
    expect(backoff.isPaused).toBe(false);
    expect(backoff.dueToRun()).toBe(true);
    expect(journal.events).toHaveLength(1); // still only the one pause row
  });

  it('a clean tick clears the streak and lifts a pause outright', () => {
    const journal = fakeJournal();
    const backoff = new QueueTickBackoff(journal, { now: () => 0 });

    backoff.onError('boom');
    backoff.onError('boom');
    backoff.onError('boom');
    expect(backoff.isPaused).toBe(true);

    backoff.onSuccess();
    expect(backoff.isPaused).toBe(false);
    expect(backoff.dueToRun()).toBe(true);

    // The streak is gone too: two more of the same error do not re-pause it.
    backoff.onError('boom');
    backoff.onError('boom');
    expect(backoff.isPaused).toBe(false);
  });

  it('while paused on the same error, each retry pushes the next attempt out a full interval', () => {
    let now = 0;
    const journal = fakeJournal();
    const backoff = new QueueTickBackoff(journal, { now: () => now, dripMs: 600_000 });

    backoff.onError('boom');
    backoff.onError('boom');
    backoff.onError('boom'); // paused at t=0
    now = 600_000;
    expect(backoff.dueToRun()).toBe(true);
    backoff.onError('boom'); // still the same error, still paused: resets the drip clock
    now = 900_000; // only 300_000 since the last error, short of a fresh 600_000 drip
    expect(backoff.dueToRun()).toBe(false);
  });
});
