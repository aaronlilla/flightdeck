/**
 * Decision 6: no Fable call anywhere in Council. When the judge and the Codex lane
 * disagree on the verdict, FIX FIRST wins rather than escalating to a third opinion.
 */
import { describe, expect, it } from 'vitest';

import { reconcileJudgeAndCodex } from '../../../src/forge/council/gate.ts';

describe('reconcileJudgeAndCodex (decision 6)', () => {
  it('agreement on PASS stays PASS', () => {
    expect(reconcileJudgeAndCodex('PASS', 'PASS')).toBe('PASS');
  });

  it('judge PASS, Codex FIX FIRST: disagreement, FIX FIRST wins', () => {
    expect(reconcileJudgeAndCodex('PASS', 'FIX FIRST')).toBe('FIX FIRST');
  });

  it('judge FIX FIRST, Codex PASS: disagreement, FIX FIRST wins', () => {
    expect(reconcileJudgeAndCodex('FIX FIRST', 'PASS')).toBe('FIX FIRST');
  });

  it('no Codex lane ran: the judge alone decides', () => {
    expect(reconcileJudgeAndCodex('PASS WITH NOTES', undefined)).toBe('PASS WITH NOTES');
  });

  it('PASS vs PASS WITH NOTES is not treated as a disagreement worth a fix round', () => {
    expect(reconcileJudgeAndCodex('PASS', 'PASS WITH NOTES')).toBe('PASS WITH NOTES');
  });
});
