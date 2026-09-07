/**
 * The orchestrator that composes the lens/Codex/judge roles into one council round. Every
 * role is a fake: no model call, no Codex call, anywhere in this file.
 */
import { describe, expect, it } from 'vitest';

import { runCouncilRound } from '../../../src/forge/council/orchestrate.ts';
import type { LensRunner, CodexLane, Judge } from '../../../src/forge/council/roles.ts';
import type { CouncilLensReport } from '../../../src/forge/contracts.ts';

function fakeLensRunner(reportsByLens: Record<string, CouncilLensReport>): LensRunner {
  return {
    async run(input) {
      return reportsByLens[input.lens] ?? { lens: input.lens, findings: [] };
    },
  };
}

function fakeCodexLane(findings: CouncilLensReport['findings']): CodexLane {
  return { async run() { return { ran: true, findings }; } };
}

function fakeJudge(verdict: 'PASS' | 'PASS WITH NOTES' | 'FIX FIRST'): Judge {
  return { async decide() { return { verdict, decidingFindings: [] }; } };
}

describe('runCouncilRound', () => {
  it('a small, non-risky diff runs one lens and skips Codex entirely', async () => {
    const lensRunner = fakeLensRunner({ correctness: { lens: 'correctness', findings: [] } });
    let codexCalled = false;
    const codexLane: CodexLane = { async run() { codexCalled = true; return { ran: true, findings: [] }; } };
    const judge = fakeJudge('PASS');

    const result = await runCouncilRound(
      { brief: 'fix retry', diffSummary: 'small diff', changedLines: 10, paths: ['src/x.ts'], ci: { runId: 'r', headSha: 'a' } },
      { lensRunner, codexLane, judge },
    );

    expect(result.lensReports.length).toBe(1);
    expect(codexCalled).toBe(false);
    expect(result.verdict).toBe('PASS');
  });

  it('a risky-path diff always runs Codex, regardless of size', async () => {
    const lensRunner = fakeLensRunner({});
    let codexCalled = false;
    const codexLane: CodexLane = { async run() { codexCalled = true; return { ran: true, findings: [] }; } };
    const judge = fakeJudge('PASS');

    await runCouncilRound(
      { brief: 'x', diffSummary: 'y', changedLines: 5, paths: ['src/features/wallet/pay.ts'], ci: { runId: 'r', headSha: 'a' } },
      { lensRunner, codexLane, judge },
    );

    expect(codexCalled).toBe(true);
  });

  it('the judge input never carries the raw diffSummary text', async () => {
    const lensRunner = fakeLensRunner({});
    const codexLane = fakeCodexLane([]);
    let seenInput: unknown;
    const judge: Judge = { async decide(input) { seenInput = input; return { verdict: 'PASS', decidingFindings: [] }; } };

    await runCouncilRound(
      { brief: 'x', diffSummary: 'RAW DIFF TEXT MUST NOT REACH THE JUDGE', changedLines: 5, paths: ['src/x.ts'], ci: { runId: 'r', headSha: 'a' } },
      { lensRunner, codexLane, judge },
    );

    expect(JSON.stringify(seenInput)).not.toContain('RAW DIFF TEXT');
  });

  it('P5.7: forceCodex runs Codex on a small, non-risky diff that would otherwise skip it', async () => {
    const lensRunner = fakeLensRunner({ correctness: { lens: 'correctness', findings: [] } });
    let codexCalled = false;
    const codexLane: CodexLane = { async run() { codexCalled = true; return { ran: true, findings: [] }; } };
    const judge = fakeJudge('PASS');

    await runCouncilRound(
      {
        brief: 'x', diffSummary: 'y', changedLines: 10, paths: ['src/x.ts'],
        ci: { runId: 'r', headSha: 'a' }, forceCodex: true,
      },
      { lensRunner, codexLane, judge },
    );

    expect(codexCalled).toBe(true);
  });

  it('a forced round with a lane that did not run fails to clear and carries that finding', async () => {
    const lensRunner = fakeLensRunner({ correctness: { lens: 'correctness', findings: [] } });
    const codexLane: CodexLane = {
      async run() { return { ran: false, findings: [], reason: 'the codex lane needs both cwd and baseRef' }; },
    };
    // The judge would clear this round on its own -- the gap has to override that,
    // never merely hope the judge notices.
    const judge = fakeJudge('PASS');

    const result = await runCouncilRound(
      {
        brief: 'x', diffSummary: 'y', changedLines: 10, paths: ['src/x.ts'],
        ci: { runId: 'r', headSha: 'a' }, forceCodex: true,
      },
      { lensRunner, codexLane, judge },
    );

    expect(result.verdict).toBe('FIX FIRST');
    expect(result.decidingFindings.some((f) => f.claim.includes('Codex lane did not run'))).toBe(true);
  });

  it('the judge itself sees the gap: a forced round with a missing lane passes a codex-lens packet', async () => {
    const lensRunner = fakeLensRunner({});
    const codexLane: CodexLane = { async run() { return { ran: false, findings: [] }; } };
    let seenInput: unknown;
    const judge: Judge = { async decide(input) { seenInput = input; return { verdict: 'PASS', decidingFindings: [] }; } };

    await runCouncilRound(
      {
        brief: 'x', diffSummary: 'y', changedLines: 10, paths: ['src/x.ts'],
        ci: { runId: 'r', headSha: 'a' }, forceCodex: true,
      },
      { lensRunner, codexLane, judge },
    );

    expect(JSON.stringify(seenInput)).toContain('Codex lane did not run');
  });

  describe('coverage (GATE.md items 1, 2 and 4): a member that never answers cannot let the round pass', () => {
    it('the BBZ-99 shape -- two of three lenses fail even after a retry -- forces FIX FIRST though the judge said PASS WITH NOTES', async () => {
      let calls: Record<string, number> = {};
      const lensRunner: LensRunner = {
        async run(input) {
          calls[input.lens] = (calls[input.lens] ?? 0) + 1;
          if (input.lens === 'correctness' || input.lens === 'scope-conformance') {
            return { lens: input.lens, failed: true, rawReply: 'not json', findings: [] };
          }
          return { lens: input.lens, findings: [] };
        },
      };
      const codexLane = fakeCodexLane([]);
      const judge = fakeJudge('PASS WITH NOTES');

      const result = await runCouncilRound(
        { brief: 'x', diffSummary: 'y', changedLines: 200, paths: ['src/x.ts'], ci: { runId: 'r', headSha: 'a' } },
        { lensRunner, codexLane, judge },
      );

      // One retry each for the two failed lenses, never a second retry.
      expect(calls['correctness']).toBe(2);
      expect(calls['scope-conformance']).toBe(2);
      expect(result.verdict).toBe('FIX FIRST');
      expect(result.missingMembers.sort()).toEqual(['correctness', 'scope-conformance']);
      expect(result.membersTotal).toBe(3);
      expect(result.decidingFindings.some((f) => f.file === '(coverage)')).toBe(true);
    });

    it('a lens that fails once and succeeds on retry counts as covered, not missing', async () => {
      let attempt = 0;
      const lensRunner: LensRunner = {
        async run(input) {
          if (input.lens !== 'correctness') return { lens: input.lens, findings: [] };
          attempt += 1;
          if (attempt === 1) return { lens: input.lens, failed: true, rawReply: 'bad', findings: [] };
          return { lens: input.lens, findings: [] };
        },
      };
      const codexLane = fakeCodexLane([]);
      const judge = fakeJudge('PASS');

      const result = await runCouncilRound(
        { brief: 'x', diffSummary: 'y', changedLines: 10, paths: ['src/x.ts'], ci: { runId: 'r', headSha: 'a' } },
        { lensRunner, codexLane, judge },
      );

      expect(result.missingMembers).toEqual([]);
      expect(result.verdict).toBe('PASS');
      expect(result.lensReports.find((r) => r.lens === 'correctness')?.retried).toBe(true);
      expect(result.lensReports.find((r) => r.lens === 'correctness')?.failed).toBeFalsy();
    });

    it('a lens failure never reaches the judge as one of its packets', async () => {
      const lensRunner: LensRunner = {
        async run(input) {
          if (input.lens === 'correctness') return { lens: input.lens, failed: true, rawReply: 'bad', findings: [] };
          return { lens: input.lens, findings: [] };
        },
      };
      const codexLane = fakeCodexLane([]);
      let seenInput: unknown;
      const judge: Judge = { async decide(input) { seenInput = input; return { verdict: 'PASS', decidingFindings: [] }; } };

      await runCouncilRound(
        { brief: 'x', diffSummary: 'y', changedLines: 10, paths: ['src/x.ts'], ci: { runId: 'r', headSha: 'a' } },
        { lensRunner, codexLane, judge },
      );

      expect(JSON.stringify(seenInput)).not.toContain('unparseable');
      expect(JSON.stringify(seenInput)).not.toContain('coverage is missing');
    });

    it('full coverage reports zero missing members', async () => {
      const lensRunner = fakeLensRunner({ correctness: { lens: 'correctness', findings: [] } });
      const codexLane = fakeCodexLane([]);
      const judge = fakeJudge('PASS');

      const result = await runCouncilRound(
        { brief: 'x', diffSummary: 'y', changedLines: 10, paths: ['src/x.ts'], ci: { runId: 'r', headSha: 'a' } },
        { lensRunner, codexLane, judge },
      );

      expect(result.missingMembers).toEqual([]);
      expect(result.membersTotal).toBe(1);
    });
  });
});
