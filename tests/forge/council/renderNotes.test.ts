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

describe('findingsTextFrom', () => {
  it('renders each deciding finding with its member, severity, place, claim and scenario', async () => {
    const { findingsTextFrom } = await import('../../../src/forge/council/renderNotes.js');
    const text = findingsTextFrom({ decidingFindings: [
      { member: 'correctness', file: 'src/a.ts', line: 12, claim: 'rethrows for every caller', failureScenario: 'a caller with no catch crashes', severity: 'medium', confidence: 'high' },
      { claim: 'bare claim' },
    ] });
    expect(text.split('\n')).toEqual([
      '- [medium/high] correctness: rethrows for every caller (src/a.ts:12)',
      '  a caller with no catch crashes',
      '- bare claim',
    ]);
  });
  it('is empty when the round decided on nothing', async () => {
    const { findingsTextFrom } = await import('../../../src/forge/council/renderNotes.js');
    expect(findingsTextFrom({ decidingFindings: [] })).toBe('');
  });
});
