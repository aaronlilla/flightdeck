/**
 * Council's gate mechanics: synthesis, the judge's packets-only contract, the three
 * fix-round loop, the RN and backend merge gates, and the squash-merge call shape.
 * Acceptance specimens 1, 2, 3, 4, 5, 6, 10 from `2026-09-04-forge-council.md`.
 *
 * No model call, no `gh` write, no Codex call anywhere in this file: every lens, judge
 * and Codex result is a fabricated fixture.
 */
import { describe, expect, it } from 'vitest';

import { synthesizeFindings } from '../../../src/forge/council/synthesis.ts';
import { evaluateFixRounds } from '../../../src/forge/council/rounds.ts';
import { rnMergeGate, backendGate, buildSquashMergeCall, buildJudgeInput, verdictForRound } from '../../../src/forge/council/gate.ts';
import { diffRisk, lensCountFor } from '../../../src/forge/council/risk.ts';
import type { CouncilFinding, CouncilLensReport } from '../../../src/forge/contracts.ts';

function finding(overrides: Partial<CouncilFinding> = {}): CouncilFinding {
  return {
    member: 'correctness',
    file: 'src/x.ts',
    line: 10,
    claim: 'off by one',
    failureScenario: 'wrong result on the last item',
    severity: 'medium',
    confidence: 'low',
    ...overrides,
  };
}

describe('synthesizeFindings (acceptance specimen 1)', () => {
  it('a seeded false finding, low confidence, uncorroborated, never reaches the blocking set', () => {
    const lenses: CouncilLensReport[] = [
      { lens: 'correctness', findings: [finding({ member: 'correctness', claim: 'SEEDED FALSE CLAIM', confidence: 'low', severity: 'high' })] },
      { lens: 'regression-risk', findings: [] },
      { lens: 'scope-conformance', findings: [] },
    ];
    const result = synthesizeFindings(lenses);
    expect(result.decidingFindings.some((f) => f.claim === 'SEEDED FALSE CLAIM')).toBe(false);
  });

  it('a finding corroborated by two lenses at the same file:line does reach the blocking set', () => {
    const lenses: CouncilLensReport[] = [
      { lens: 'correctness', findings: [finding({ member: 'correctness', claim: 'real bug', severity: 'high', confidence: 'medium' })] },
      { lens: 'regression-risk', findings: [finding({ member: 'regression-risk', claim: 'real bug, confirmed', severity: 'high', confidence: 'medium' })] },
      { lens: 'scope-conformance', findings: [] },
    ];
    const result = synthesizeFindings(lenses);
    expect(result.decidingFindings.length).toBe(2);
  });

  it('a high-confidence critical finding from one lens still counts (not everything needs corroboration)', () => {
    const lenses: CouncilLensReport[] = [
      { lens: 'correctness', findings: [finding({ severity: 'critical', confidence: 'high' })] },
    ];
    const result = synthesizeFindings(lenses);
    expect(result.decidingFindings.length).toBe(1);
  });
});

describe('synthesizeFindings: Codex lane contested, not dropped (acceptance specimen 2)', () => {
  it('a Codex-only finding with no matching Sonnet finding is carried as contested', () => {
    const lenses: CouncilLensReport[] = [{ lens: 'correctness', findings: [] }];
    const codexFindings = [finding({ member: 'codex', file: 'src/y.ts', line: 99, claim: 'codex-only finding' })];
    const result = synthesizeFindings(lenses, codexFindings);
    expect(result.codexOnly.length).toBe(1);
    expect(result.codexOnly[0]?.claim).toBe('codex-only finding');
    expect(result.codexOnly[0]?.contested).toBeTruthy();
  });

  it('a Codex finding matching a Sonnet lens finding is folded into the deciding set, not left contested', () => {
    const lenses: CouncilLensReport[] = [{ lens: 'correctness', findings: [finding({ file: 'src/z.ts', line: 5 })] }];
    const codexFindings = [finding({ member: 'codex', file: 'src/z.ts', line: 5, claim: 'same spot' })];
    const result = synthesizeFindings(lenses, codexFindings);
    expect(result.codexOnly.length).toBe(0);
  });
});

describe('buildJudgeInput: packets only (acceptance specimen 3)', () => {
  it('never carries the raw diff text', () => {
    const input = buildJudgeInput({
      lenses: [{ lens: 'correctness', findings: [] }],
      brief: 'fix the retry loop',
      ci: { runId: 'r1', headSha: 'aaa' },
      diff: 'this is 4000 lines of raw diff text that must never reach the judge',
    });
    expect(JSON.stringify(input)).not.toContain('raw diff text');
    expect(input).not.toHaveProperty('diff');
  });
});

describe('evaluateFixRounds: three rounds then park (acceptance specimen 4)', () => {
  it('three consecutive FIX FIRST verdicts produce exactly one park event with the packet attached', () => {
    const rounds = [
      { round: 1, verdict: 'FIX FIRST' as const, findings: [finding({ claim: 'round 1' })] },
      { round: 2, verdict: 'FIX FIRST' as const, findings: [finding({ claim: 'round 2' })] },
      { round: 3, verdict: 'FIX FIRST' as const, findings: [finding({ claim: 'round 3' })] },
      { round: 4, verdict: 'FIX FIRST' as const, findings: [finding({ claim: 'round 4 -- must never be entered' })] },
    ];
    const outcome = evaluateFixRounds(rounds);
    expect(outcome.parked).toBe(true);
    expect(outcome.enteredRounds).toBe(3);
    expect(outcome.packet).toBeTruthy();
    expect(outcome.packet?.some((f) => f.claim.includes('round 4'))).toBe(false);
  });

  it('a PASS on round two stops the loop with no park', () => {
    const rounds = [
      { round: 1, verdict: 'FIX FIRST' as const, findings: [] },
      { round: 2, verdict: 'PASS' as const, findings: [] },
    ];
    const outcome = evaluateFixRounds(rounds);
    expect(outcome.parked).toBe(false);
    expect(outcome.enteredRounds).toBe(2);
  });
});

describe('rnMergeGate: refuses on a stale check run (acceptance specimen 5)', () => {
  it('blocks merge when the check-run head sha does not match the current head, even though conclusion is success', () => {
    const decision = rnMergeGate({
      judgeVerdict: 'PASS',
      codexVerdict: 'PASS',
      ci: { runId: 'run-1', headSha: 'old-sha', conclusion: 'success' },
      currentHeadSha: 'new-sha',
    });
    expect(decision.allow).toBe(false);
  });

  it('allows merge when every gate condition is green and the check run matches the current head', () => {
    const decision = rnMergeGate({
      judgeVerdict: 'PASS',
      codexVerdict: 'PASS WITH NOTES',
      ci: { runId: 'run-2', headSha: 'new-sha', conclusion: 'success' },
      currentHeadSha: 'new-sha',
    });
    expect(decision.allow).toBe(true);
  });

  it('blocks merge on FIX FIRST even with a matching, successful check run', () => {
    const decision = rnMergeGate({
      judgeVerdict: 'FIX FIRST',
      codexVerdict: 'PASS',
      ci: { runId: 'run-3', headSha: 'new-sha', conclusion: 'success' },
      currentHeadSha: 'new-sha',
    });
    expect(decision.allow).toBe(false);
  });
});

describe('backendGate: never merges (acceptance specimen 6)', () => {
  it('every gate condition green still ends at draft-PR-plus-ping, never a merge call', () => {
    const result = backendGate({
      judgeVerdict: 'PASS',
      codexVerdict: 'PASS',
      ci: { runId: 'run-4', headSha: 'x', conclusion: 'success' },
    });
    expect(result.action).toBe('open-draft-pr');
    expect(JSON.stringify(result)).not.toMatch(/merge/i);
  });
});

describe('buildSquashMergeCall: never inherits the default (acceptance specimen 10)', () => {
  it('a ten-commit branch still produces an explicit subject and a short body', () => {
    const commits = Array.from({ length: 10 }, (_, i) => `commit message number ${i + 1}`);
    const call = buildSquashMergeCall({ commits, subject: 'Fix the retry loop', body: 'Backs off once instead of every tick.' });
    expect(call.subject).toBe('Fix the retry loop');
    expect(call.body).toBe('Backs off once instead of every tick.');
    expect(call.args).toContain('--subject');
    expect(call.args).toContain('--body');
    expect(call.args.join(' ')).not.toContain('commit message number 1\n');
  });
});

describe('verdictForRound: coverage decided in code, never left to the judge (GATE.md item 1)', () => {
  it('the BBZ-99 shape -- judge says PASS WITH NOTES, two members never answered -- still cannot clear', () => {
    const verdict = verdictForRound('PASS WITH NOTES', { missingMembers: ['correctness', 'scope-conformance'] });
    expect(verdict).toBe('FIX FIRST');
  });

  it('a judge PASS with full coverage clears unchanged', () => {
    const verdict = verdictForRound('PASS', { missingMembers: [] });
    expect(verdict).toBe('PASS');
  });

  it('a judge FIX FIRST with full coverage stays FIX FIRST (coverage never loosens a verdict either)', () => {
    const verdict = verdictForRound('FIX FIRST', { missingMembers: [] });
    expect(verdict).toBe('FIX FIRST');
  });

  it('one missing member out of many is still enough to block', () => {
    const verdict = verdictForRound('PASS', { missingMembers: ['codex'] });
    expect(verdict).toBe('FIX FIRST');
  });
});

describe('diffRisk / lensCountFor: scaled to diff risk (decision 5)', () => {
  it('a small diff with no risky path gets one lens', () => {
    const risk = diffRisk({ changedLines: 40, paths: ['src/x.ts'] });
    expect(risk.level).toBe('small');
    expect(lensCountFor(risk)).toBe(1);
  });

  it('a medium diff gets three lenses', () => {
    const risk = diffRisk({ changedLines: 200, paths: ['src/x.ts'] });
    expect(risk.level).toBe('medium');
    expect(lensCountFor(risk)).toBe(3);
  });

  it('any risky path forces the Codex lane regardless of size', () => {
    const risk = diffRisk({ changedLines: 10, paths: ['src/features/wallet/pay.ts'] });
    expect(risk.needsCodex).toBe(true);
  });
});
