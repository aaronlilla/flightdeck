import { describe, expect, it } from 'vitest';

import { parkRecoverability } from '../../../src/forge/intake/queue.js';

/**
 * A ticket whose work already landed is not planned again every ten minutes.
 *
 * Traced on the live board, 2026-09-13, one ticket, three cycles, and fifteen tickets
 * doing the same thing:
 *
 *   04:21:28  restarted: "parked 9 min ago with no blocker and no open question"
 *   04:21:44  planning                 <- a planner call
 *   04:21:47  parked: "BBZ-199 already has a merged pull request: .../pull/96"
 *   04:21:48  recovery-declined: "no rule covers the park reason ..."
 *   04:31:28  restarted again. And at 04:41:28. For ever.
 *
 * The restart asks whether anything is blocking the item, never why it parked. The check
 * that knows runs afterwards, so the planner call is already spent by the time anything
 * declines it. Fifteen tickets on a ten-minute cycle is roughly ninety wasted planner
 * calls an hour, on work that has already shipped.
 *
 * `parkRecoverability` is where that knowledge lives, and it did not recognise this
 * reason. Unrecognised means "retry" by design -- so a network blip never becomes a
 * person's job for good -- and a ticket whose pull request already exists is the opposite
 * of a blip.
 */
describe('a park that says the work already exists', () => {
  const cases = [
    'BBZ-199 already has a merged pull request: https://github.com/owner/name/pull/96',
    'BBZ-102 already has an open pull request: https://github.com/owner/name/pull/73',
  ];

  it.each(cases)('is a person\'s call, not something to retry (%s)', (reason) => {
    const verdict = parkRecoverability(reason);
    expect(verdict.recoverable).toBe(false);
    expect(
      'personsCall' in verdict && verdict.personsCall,
      `"${reason}" would be retried every ten minutes for ever`,
    ).toBe(true);
  });

  it('says why in words that name the pull request as the reason', () => {
    const verdict = parkRecoverability(cases[0]!);
    expect('why' in verdict && verdict.why).toMatch(/pull request/i);
  });

  // The fail-closed default is deliberate and must survive: something nobody has
  // classified is still retried, so one bad network moment never becomes permanent.
  it('leaves an unclassified reason retrying, which is the whole point of the default', () => {
    const verdict = parkRecoverability('some launcher error nobody has seen before');
    expect(verdict.recoverable).toBe(false);
    expect('personsCall' in verdict && verdict.personsCall).not.toBe(true);
  });

  it('does not catch a sentence that merely mentions a pull request', () => {
    const verdict = parkRecoverability('the push to its pull request was refused');
    expect('personsCall' in verdict && verdict.personsCall).not.toBe(true);
  });
});
