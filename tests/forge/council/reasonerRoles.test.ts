/**
 * `reasonerRoles.ts` built on top of a fake `Reasoner` -- no model call anywhere here.
 */
import { describe, expect, it } from 'vitest';

import type { Reasoner } from '../../../src/forge/contracts.ts';
import { buildJudgeInput } from '../../../src/forge/council/gate.ts';
import { codexLaneFor, reasonerJudge, reasonerLensRunner } from '../../../src/forge/council/reasonerRoles.ts';

function fakeReasoner(reply: string): Reasoner {
  return { provider: 'claude', async call() { return { text: reply }; } };
}

describe('reasonerLensRunner', () => {
  it('parses a bare JSON array reply into a lens report', async () => {
    const finding = {
      member: 'correctness', file: 'src/x.ts', line: 5, claim: 'off by one',
      failureScenario: 'crashes on empty input', severity: 'high', confidence: 'high',
    };
    const runner = reasonerLensRunner(fakeReasoner(JSON.stringify([finding])));
    const report = await runner.run({ lens: 'correctness', brief: 'b', diffSummary: 'd' });
    expect(report.lens).toBe('correctness');
    expect(report.findings).toEqual([finding]);
  });

  it('an unparseable reply reads as no findings rather than throwing', async () => {
    const runner = reasonerLensRunner(fakeReasoner('not json'));
    const report = await runner.run({ lens: 'correctness', brief: 'b', diffSummary: 'd' });
    expect(report.findings).toEqual([]);
  });

  it('a reply shaped as {findings: [...]} is also accepted', async () => {
    const finding = {
      member: 'scope-conformance', file: 'src/y.ts', line: 1, claim: 'out of scope edit',
      failureScenario: 'touches unrelated module', severity: 'medium', confidence: 'medium',
    };
    const runner = reasonerLensRunner(fakeReasoner(JSON.stringify({ findings: [finding] })));
    const report = await runner.run({ lens: 'scope-conformance', brief: 'b', diffSummary: 'd' });
    expect(report.findings).toEqual([finding]);
  });
});

describe('reasonerJudge', () => {
  it('parses a valid verdict reply', async () => {
    const judge = reasonerJudge(fakeReasoner(JSON.stringify({ verdict: 'PASS', decidingFindings: [] })));
    const input = buildJudgeInput({ lenses: [], brief: 'b', ci: { runId: 'r', headSha: 'h' }, diff: 'RAW DIFF' });
    const result = await judge.decide(input);
    expect(result.verdict).toBe('PASS');
  });

  it('the falsifier: the judge input never carries the raw diff text', async () => {
    let seen: unknown;
    const judge = reasonerJudge({
      provider: 'claude',
      async call(input) { seen = input.prompt; return { text: JSON.stringify({ verdict: 'PASS' }) }; },
    });
    const input = buildJudgeInput({ lenses: [], brief: 'b', ci: { runId: 'r', headSha: 'h' }, diff: 'RAW DIFF TEXT MARKER' });
    await judge.decide(input);
    expect(String(seen)).not.toContain('RAW DIFF TEXT MARKER');
  });

  it('a reply that fails validation resolves to FIX FIRST, never a silent PASS', async () => {
    const judge = reasonerJudge(fakeReasoner('garbage'));
    const input = buildJudgeInput({ lenses: [], brief: 'b', ci: { runId: 'r', headSha: 'h' }, diff: 'x' });
    const result = await judge.decide(input);
    expect(result.verdict).toBe('FIX FIRST');
  });
});

describe('codexLaneFor', () => {
  it('never runs when council.codex is off (the default)', async () => {
    const lane = codexLaneFor({ smallMaxLines: 100, largeMinLines: 500, riskyPaths: [], codex: 'off', allowedRepos: [], autoMerge: [] });
    const result = await lane.run({ brief: 'b', diffSummary: 'd' });
    expect(result.ran).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it('refuses loudly when council.codex is on, since no Codex lane is implemented here', async () => {
    const lane = codexLaneFor({ smallMaxLines: 100, largeMinLines: 500, riskyPaths: [], codex: 'on', allowedRepos: [], autoMerge: [] });
    await expect(lane.run({ brief: 'b', diffSummary: 'd' })).rejects.toThrow(/codex_call\.py/);
  });
});
