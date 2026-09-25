/**
 * `council/bugHunt.ts` built on top of a fake `Reasoner` -- no model call anywhere here.
 * Aaron's 2026-09-23 standing order (full autonomous mode): a dedicated opus-5-5 bug-hunt
 * pass runs after the council itself clears and before an autonomous merge.
 */
import { describe, expect, it } from 'vitest';

import type { Reasoner } from '../../../src/forge/contracts.ts';
import { buildBugHuntPrompt, reasonerBugHunter } from '../../../src/forge/council/bugHunt.ts';

function fakeReasoner(reply: string): Reasoner {
  return { provider: 'claude', async call() { return { text: reply }; } };
}

describe('buildBugHuntPrompt', () => {
  it('carries the brief, the diff, and the surrounding code when supplied', () => {
    const prompt = buildBugHuntPrompt({
      brief: 'fixes the retry loop', diffSummary: '+ retries += 1',
      surroundingCode: '--- src/retry.ts ---\nfunction retry() {}',
    });
    expect(prompt).toContain('fixes the retry loop');
    expect(prompt).toContain('+ retries += 1');
    expect(prompt).toContain('function retry() {}');
  });

  it('omits the surrounding-code section entirely when none is supplied', () => {
    const prompt = buildBugHuntPrompt({ brief: 'x', diffSummary: 'y' });
    expect(prompt).not.toContain('Surrounding code');
  });

  it('asks for the bug-hunt member name on every finding, not a lens name', () => {
    const prompt = buildBugHuntPrompt({ brief: 'x', diffSummary: 'y' });
    expect(prompt).toContain('"bug-hunt"');
  });
});

describe('reasonerBugHunter', () => {
  it('a clean reply carries no findings', async () => {
    const hunter = reasonerBugHunter(fakeReasoner(JSON.stringify({ clean: true, findings: [] })));
    const result = await hunter.run({ brief: 'x', diffSummary: 'y' });
    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failed).toBeFalsy();
  });

  it('a dirty reply carries its findings, each tagged as the bug-hunt member', async () => {
    const finding = {
      member: 'bug-hunt', file: 'src/x.ts', line: 12, claim: 'unbounded retry loop',
      failureScenario: 'never breaks out on a permanent failure', severity: 'high', confidence: 'high',
    };
    const hunter = reasonerBugHunter(fakeReasoner(JSON.stringify({ clean: false, findings: [finding] })));
    const result = await hunter.run({ brief: 'x', diffSummary: 'y' });
    expect(result.clean).toBe(false);
    expect(result.findings).toEqual([finding]);
  });

  // Fail-closed, same instinct as `reasonerRoles.ts`'s judge: an unreadable reply must
  // never be treated as "no bugs", since that would let a real defect sail through to
  // an unattended merge on a reply nobody could actually read.
  it('an unparseable reply fails closed: not clean, with a generic finding explaining why', async () => {
    const hunter = reasonerBugHunter(fakeReasoner('sorry, nothing concrete to report here'));
    const result = await hunter.run({ brief: 'x', diffSummary: 'y' });
    expect(result.clean).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.claim).toMatch(/unparseable/);
  });

  it('a reply missing the clean field entirely fails closed the same way', async () => {
    const hunter = reasonerBugHunter(fakeReasoner(JSON.stringify({ findings: [] })));
    const result = await hunter.run({ brief: 'x', diffSummary: 'y' });
    expect(result.clean).toBe(false);
    expect(result.failed).toBe(true);
  });

  it('reasons on the bug-hunt class, distinct from a lens or the judge', async () => {
    let seenClassName: string | undefined;
    const hunter = reasonerBugHunter({
      provider: 'claude',
      async call(input) { seenClassName = input.className; return { text: JSON.stringify({ clean: true, findings: [] }) }; },
    });
    await hunter.run({ brief: 'x', diffSummary: 'y' });
    expect(seenClassName).toBe('bug-hunt');
  });
});
