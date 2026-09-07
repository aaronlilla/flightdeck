import { describe, expect, it } from 'vitest';

import { renderNotes } from '../../../src/forge/council/renderNotes.js';

describe('renderNotes', () => {
  it('renders the verdict and the findings text', () => {
    const text = renderNotes({ verdict: 'PASS WITH NOTES', findingsText: '[low/medium] src/x.ts:1 -- minor nit' });
    expect(text).toContain('Council verdict: PASS WITH NOTES.');
    expect(text).toContain('minor nit');
  });

  it('names the coverage gap when one is present', () => {
    const text = renderNotes({ verdict: 'FIX FIRST', coverageNote: 'reviewed by 1 of 3 (missing: regression-risk)' });
    expect(text).toContain('Coverage: reviewed by 1 of 3 (missing: regression-risk).');
  });

  it('says plainly when there are no deciding findings', () => {
    const text = renderNotes({ verdict: 'PASS' });
    expect(text).toContain('No deciding findings.');
  });
});
