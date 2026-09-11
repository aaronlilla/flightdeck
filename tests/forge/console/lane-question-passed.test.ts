import { describe, expect, it } from 'vitest';

import { questionFor } from '../../../src/forge/console/lanes.js';
import type { InboxEntry } from '../../../src/forge/inbox.js';

/**
 * R-75 item 4, the server half. `LaneQuestion` carries four Pass to… fields added by the
 * spec PR -- `passedTo`, `passedAt`, `passedThread`, `answeredBy` -- and the lane reader
 * built its question from six fields and dropped all four. The console could render a
 * pass, but a real pass reverted to un-passed on the next lanes read, because the fields
 * never reached the browser.
 *
 * This fails if either side changes shape alone: R-76 writes the fields onto the ask,
 * R-75 renders them, and this is the seam between.
 */
const PASSED_FIELDS = ['passedTo', 'passedAt', 'passedThread', 'answeredBy'] as const;

function passedAsk(): InboxEntry {
  return {
    key: 'ask-1',
    question: 'Do we keep the old column?',
    options: ['Keep it', 'Drop it'],
    kind: 'question',
    runs: ['alpha'],
    goals: ['alpha'],
    asked: 1,
    at: 2_000,
    disposition: 'park',
    recommended: 0,
    optionSource: 'worker',
    passedTo: 'Joe',
    passedAt: 1_788_000_000_000,
    passedThread: '1788000000.000100',
    answeredBy: 'Joe',
  } as unknown as InboxEntry;
}

describe('the lane reader carries the Pass to… fields through (R-75 item 4)', () => {
  it('puts every one of the four fields on the lane question', () => {
    const question = questionFor('alpha', [passedAsk()]);
    expect(question, 'the parked lane has no question at all').not.toBeNull();
    const ask = passedAsk() as unknown as Record<string, unknown>;
    for (const field of PASSED_FIELDS) {
      expect(
        (question as unknown as Record<string, unknown>)[field],
        `${field} was dropped between the ask and the lane question`,
      ).toBe(ask[field]);
    }
  });

  it('keeps the six fields it always carried', () => {
    const question = questionFor('alpha', [passedAsk()]);
    expect(question?.key).toBe('ask-1');
    expect(question?.text).toBe('Do we keep the old column?');
    expect(question?.opts).toEqual(['Keep it', 'Drop it']);
    expect(question?.askedAt).toBe(2_000);
    expect(question?.recommended).toBe(0);
    expect(question?.optionSource).toBe('worker');
  });

  it('reads null, not undefined, when the ask has not been passed', () => {
    const plain = { ...(passedAsk() as unknown as Record<string, unknown>) };
    for (const field of PASSED_FIELDS) delete plain[field];
    const question = questionFor('alpha', [plain as unknown as InboxEntry]);
    expect(question).not.toBeNull();
    for (const field of PASSED_FIELDS) {
      expect(
        (question as unknown as Record<string, unknown>)[field],
        `${field} should read null when nothing passed this ask`,
      ).toBeNull();
    }
  });

  it('still answers null for a run with no open ask', () => {
    expect(questionFor('beta', [passedAsk()])).toBeNull();
  });
});
