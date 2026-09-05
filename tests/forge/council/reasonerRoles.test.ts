/**
 * `reasonerRoles.ts` built on top of a fake `Reasoner` -- no model call anywhere here.
 */
import { describe, expect, it } from 'vitest';

import type { Reasoner } from '../../../src/forge/contracts.ts';
import { buildJudgeInput } from '../../../src/forge/council/gate.ts';
import { codexLaneFor, reasonerJudge, reasonerLensRunner } from '../../../src/forge/council/reasonerRoles.ts';
import { ReasonerParseError } from '../../../src/forge/reasoner-claude.ts';

function fakeReasoner(reply: string): Reasoner {
  return { provider: 'claude', async call() { return { text: reply }; } };
}

/** The real `ClaudeReasoner` rejects rather than resolving when a reply cannot be
 *  parsed at all (a prose answer, for instance) -- this is that behavior, faked, so
 *  `reasonerLensRunner` is exercised against the same failure mode production hits
 *  rather than only ever seeing a resolved (if garbled) `.text`. */
function rejectingReasoner(raw: string): Reasoner {
  return { provider: 'claude', async call() { throw new ReasonerParseError(raw); } };
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

  // I19: a live run had this exact rejection propagate uncaught through
  // `Promise.all` in `orchestrate.ts` and take the process down. `run()` must resolve,
  // never reject, whatever the reasoner does.
  it('a reply that rejects entirely (prose, or any unparseable text) resolves to a failed lens report, never a rejected promise', async () => {
    const runner = reasonerLensRunner(rejectingReasoner('sorry, nothing concrete to report here'));
    const report = await runner.run({ lens: 'correctness', brief: 'b', diffSummary: 'd' });

    expect(report.lens).toBe('correctness');
    expect(report.failed).toBe(true);
    expect(report.rawReply).toBe('sorry, nothing concrete to report here');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe('medium');
    expect(report.findings[0]?.claim).toMatch(/correctness.*unparseable reply/);
  });

  it('asks the reasoner for an array reply shape, since a lens\'s whole answer is a findings array', async () => {
    let seenShape: string | undefined;
    const runner = reasonerLensRunner({
      provider: 'claude',
      async call(input) { seenShape = input.replyShape; return { text: '[]' }; },
    });
    await runner.run({ lens: 'correctness', brief: 'b', diffSummary: 'd' });
    expect(seenShape).toBe('array');
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

  it('wires the real lane when council.codex is on, which refuses to run without cwd/baseRef', async () => {
    const lane = codexLaneFor({ smallMaxLines: 100, largeMinLines: 500, riskyPaths: [], codex: 'on', allowedRepos: [], autoMerge: [] });
    const result = await lane.run({ brief: 'b', diffSummary: 'd' });
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/cwd/);
  });
});
