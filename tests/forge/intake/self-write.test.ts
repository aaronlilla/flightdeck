/**
 * Requirement 4, self-write half — decision 6: every Jira write carries a hidden marker
 * comment with the operation id; the poller drops any update whose author is Aaron's
 * account AND whose body carries a marker Intake wrote. Haiping's own comments must
 * still pass through (the acceptance specimen's own falsifier: filtering by author name
 * alone would wrongly suppress him too).
 */
import { describe, expect, it } from 'vitest';

import {
  isSelfWrite, markerFor, stripMarker, withMarker,
} from '../../../src/forge/intake/selfWrite.js';

describe('markerFor / withMarker / stripMarker', () => {
  it('embeds a hidden, round-trippable marker carrying the operation id', () => {
    const body = withMarker('Looked into this, filed the fix under BBZ-142.', 'op-77');
    expect(body).toContain(markerFor('op-77'));
    expect(stripMarker(body)).toBe('Looked into this, filed the fix under BBZ-142.');
  });
});

describe('isSelfWrite — falsifier: author name alone is not enough', () => {
  const AARON = 'aaron@example.com';

  it('is true only when BOTH the author is Aaron\'s account AND the body carries an Intake marker', () => {
    const selfBody = withMarker('Triangulated and filed a packet.', 'op-1');
    expect(isSelfWrite({ author: AARON, body: selfBody }, AARON)).toBe(true);
  });

  it('is false for Aaron\'s own account writing with no marker (a real human comment)', () => {
    expect(isSelfWrite({ author: AARON, body: 'looks fine to me, ship it' }, AARON)).toBe(false);
  });

  it('is false for Haiping\'s comment even though it is on the same ticket Intake wrote to — his comments are never suppressed', () => {
    const haipingBody = 'QA fail: crashes on cold start with airplane mode on.';
    expect(isSelfWrite({ author: 'qa@example.com', body: haipingBody }, AARON)).toBe(false);
  });

  it('is false for a marker-bearing body from a DIFFERENT author (the marker alone proves nothing without the author match)', () => {
    const spoofed = withMarker('not actually Intake', 'op-1');
    expect(isSelfWrite({ author: 'someone-else@example.com', body: spoofed }, AARON)).toBe(false);
  });
});
