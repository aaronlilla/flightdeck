/**
 * `computeLaneSummary` (2026-09-07): the ticket sheet's top summary block.
 */
import { describe, expect, it } from 'vitest';

import {
  computeAudit, computeLaneSummary, computeNext, computeReadiness, computeWhat, type DriftFacts, type PrFacts,
} from '../../../src/forge/console/summary.js';
import { verified } from '../../../src/forge/contracts.js';
import type { CouncilAttestation } from '../../../src/forge/contracts.js';
import type { Lane, LaneStory } from '../../../src/shared/console-model.js';

function attestation(overrides: Partial<CouncilAttestation> = {}): CouncilAttestation {
  return {
    repo: 'acme/widgets', pr: 9, head: 'head-sha-1', base: 'base-sha-1', round: 1,
    verdict: 'PASS WITH NOTES',
    decidingFindings: [{ claim: 'a nit', evidence: 'x', severity: 'low', lens: 'style' } as never],
    lenses: [],
    judge: { model: 'sonnet-5', verdict: 'PASS WITH NOTES' },
    ci: { runId: 'run-1', headSha: 'head-sha-1' },
    at: verified(12_345, 'gh pr view'),
    coverage: { total: 4, missing: [] },
    ...overrides,
  };
}

function noDrift(): DriftFacts {
  return { behindBase: null, headMoved: false, commits: [] };
}

function story(entries: LaneStory['entries']): LaneStory {
  return { id: 'r1', title: 't', kind: 'ticket', ticket: null, brief: null, entries };
}

describe('computeWhat', () => {
  it('uses the PR title as the first sentence', () => {
    const pr: PrFacts = { title: 'add the merge chip', body: null, checks: null, merged: null };
    expect(computeWhat({ story: null, pr, drift: noDrift() })).toEqual(['add the merge chip.']);
  });

  it('adds the PR body\'s first paragraph and the PR\'s own commits off drift, never the story\'s whole-repo commit list', () => {
    const pr: PrFacts = { title: 'add the merge chip', body: 'This wires the button.\n\nMore detail here.', checks: null, merged: null };
    // The story carries whole-repo commits (oldest first); computeWhat must ignore them
    // and use only drift.commits -- the PR's own range, newest first.
    const s = story([
      { at: 1, kind: 'commit', text: 'Change zzz0000: unrelated repo history' },
    ]);
    const drift: DriftFacts = { ...noDrift(), commits: ['wire the merge button', 'fix a lint error'] };
    const what = computeWhat({ story: s, pr, drift });
    expect(what).toEqual([
      'add the merge chip.',
      'This wires the button.',
      'wire the merge button.',
      'fix a lint error.',
    ]);
  });

  it('never exceeds six sentences', () => {
    const drift: DriftFacts = { ...noDrift(), commits: Array.from({ length: 10 }, (_, i) => `commit number ${i}`) };
    expect(computeWhat({ story: null, pr: null, drift }).length).toBeLessThanOrEqual(6);
  });

  it('falls back to the plan and ticket lines only when the PR\'s own commits alone come up short', () => {
    const s = story([
      { at: 1, kind: 'ticket', text: 'Queued from Jira as BBZ-9 at 1:00 PM' },
      { at: 2, kind: 'plan', text: 'Planned: wire the summary block' },
    ]);
    const drift: DriftFacts = { ...noDrift(), commits: ['add the block'] };
    const what = computeWhat({ story: s, pr: null, drift });
    expect(what).toEqual([
      'add the block.',
      'Queued from Jira as BBZ-9 at 1:00 PM.',
      'wire the summary block.',
    ]);
  });

  it('never pads: a lane with nothing on record gets an empty list, not invented sentences', () => {
    expect(computeWhat({ story: null, pr: null, drift: noDrift() })).toEqual([]);
  });

  it('reduces the PR body to prose: drops a markdown heading, a fenced block, and list markers, keeping the first two sentences of the first paragraph', () => {
    const pr: PrFacts = {
      title: 'add the merge chip',
      body: [
        '## What',
        '',
        'This wires the merge button end to end. It also fixes a lint error. A third sentence should be dropped.',
        '',
        '- one',
        '- two',
        '',
        '```json',
        '{"handoff": true, "gate": "G7"}',
        '```',
      ].join('\n'),
      checks: null,
      merged: null,
    };
    const what = computeWhat({ story: null, pr, drift: noDrift() });
    expect(what).toEqual([
      'add the merge chip.',
      'This wires the merge button end to end. It also fixes a lint error.',
    ]);
  });
});

describe('computeAudit', () => {
  it('is null with no attestation on record', () => {
    expect(computeAudit(null, noDrift())).toBeNull();
  });

  it('carries the verdict, coverage and finding count off the attestation', () => {
    const audit = computeAudit(attestation(), noDrift());
    expect(audit).toMatchObject({
      verdict: 'PASS WITH NOTES', reviewed: 4, total: 4, at: 12_345, head: 'head-sha-1', findings: 1,
      stale: false, staleWhy: null,
    });
  });

  it('reports coverage gaps: reviewed is total minus missing', () => {
    const audit = computeAudit(attestation({ coverage: { total: 4, missing: ['codex'] } }), noDrift());
    expect(audit).toMatchObject({ reviewed: 3, total: 4 });
  });

  it('is stale the moment the head has moved since the attestation', () => {
    const audit = computeAudit(attestation(), { behindBase: null, headMoved: true });
    expect(audit).toMatchObject({ stale: true, staleWhy: expect.stringContaining('moved since') });
  });

  // Sweep #8: "View council" promises to show the deciding findings, not just a
  // count -- the summary must carry the text of each one.
  it('carries one line per deciding finding, member and claim', () => {
    const audit = computeAudit(attestation({
      decidingFindings: [
        { member: 'reviewer-a', claim: 'the retry can double-charge', evidence: 'x', severity: 'high', lens: 'money' } as never,
        { member: 'reviewer-b', claim: 'no test covers the empty-body case', evidence: 'y', severity: 'medium', lens: 'coverage' } as never,
      ],
    }), noDrift());
    expect(audit?.findingsText).toEqual([
      'reviewer-a: the retry can double-charge',
      'reviewer-b: no test covers the empty-body case',
    ]);
  });
});

describe('computeReadiness', () => {
  const okPr: PrFacts = { title: 't', body: null, checks: 'success', merged: false };
  const okMergeable: Lane['mergeable'] = { ok: true };

  it('is ready when checks are green, the council cleared, the repo is allow-listed, and there is no drift', () => {
    const readiness = computeReadiness({ pr: okPr, attestation: attestation(), mergeable: okMergeable, drift: noDrift() });
    expect(readiness).toEqual({ ok: true, why: null, checks: 'success', behindBase: null, headMoved: false });
  });

  it('is not ready with no PR open', () => {
    const readiness = computeReadiness({ pr: null, attestation: null, mergeable: null, drift: noDrift() });
    expect(readiness.ok).toBe(false);
    expect(readiness.why).toContain('no PR is open yet');
  });

  it('is not ready when checks are red', () => {
    const readiness = computeReadiness({ pr: { ...okPr, checks: 'failure' }, attestation: attestation(), mergeable: okMergeable, drift: noDrift() });
    expect(readiness.ok).toBe(false);
    expect(readiness.why).toContain('checks are failure');
  });

  it('is not ready with no council verdict yet', () => {
    const readiness = computeReadiness({ pr: okPr, attestation: null, mergeable: okMergeable, drift: noDrift() });
    expect(readiness.ok).toBe(false);
    expect(readiness.why).toContain('not audited yet');
  });

  it('is not ready when the council verdict did not clear', () => {
    const readiness = computeReadiness({
      pr: okPr, attestation: attestation({ verdict: 'FIX FIRST' }), mergeable: okMergeable, drift: noDrift(),
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.why).toContain('FIX FIRST');
  });

  it('is not ready when the repo is off the merge allow-list', () => {
    const readiness = computeReadiness({
      pr: okPr, attestation: attestation(), mergeable: { ok: false, why: 'controlled code, ping Joe' }, drift: noDrift(),
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.why).toContain('controlled code, ping Joe');
  });

  it('is not ready when the PR head has moved since the audit', () => {
    const readiness = computeReadiness({
      pr: okPr, attestation: attestation(), mergeable: okMergeable, drift: { behindBase: null, headMoved: true },
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.why).toContain('the PR head moved since the audit');
    expect(readiness.headMoved).toBe(true);
  });

  it('is not ready when the base has gained commits since the merge-base, and says how many', () => {
    const readiness = computeReadiness({
      pr: okPr, attestation: attestation(), mergeable: okMergeable, drift: { behindBase: 5, headMoved: false },
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.why).toContain('gained 5 commits since');
    expect(readiness.behindBase).toBe(5);
  });
});

describe('computeLaneSummary', () => {
  it('folds what/status/audit/readiness off a lane, its story, PR facts, attestation and drift', () => {
    const lane = { plain: 'Working since 1:00 on a Sonnet session, 3 turns in.', mergeable: { ok: true } } as Lane;
    const summary = computeLaneSummary({
      lane,
      story: story([{ at: 1, kind: 'commit', text: 'Change abc1234: add the summary block' }]),
      pr: { title: 'add the summary block', body: null, checks: 'success', merged: false },
      attestation: attestation(),
      drift: noDrift(),
    });
    expect(summary.status).toBe(lane.plain);
    expect(summary.what.length).toBeGreaterThan(0);
    expect(summary.audit?.verdict).toBe('PASS WITH NOTES');
    expect(summary.readiness?.ok).toBe(true);
  });
});

describe('computeNext', () => {
  const base = { retiredAt: null, runaway: false, pr: null, question: null, blockedBy: null } as unknown as Lane;
  const notReady = { ok: false, why: 'no PR is open yet', checks: null, behindBase: null, headMoved: false };
  const ready = { ok: true, why: null, checks: 'success' as const, behindBase: 0, headMoved: false };

  it('tells the operator to answer a parked question', () => {
    const lane = { ...base, state: 'parked', question: { key: 'k', text: 'Continue?', opts: [], askedAt: 1 } } as Lane;
    expect(computeNext(lane, notReady)).toMatch(/^Answer the question below/);
  });

  it('says nothing is needed while a run works', () => {
    expect(computeNext({ ...base, state: 'running' } as Lane, notReady)).toMatch(/^Nothing needed; let it work/);
  });

  it('says merge when the readiness verdict is ok, whatever the run state', () => {
    const pr = { no: 118, url: 'u', title: 't', checks: 'success', merged: false, files: 1, add: 1, del: 0 } as unknown as Lane['pr'];
    expect(computeNext({ ...base, state: 'unverified', pr } as Lane, ready)).toMatch(/^Merge it\./);
  });

  it('carries the readiness reason for a done lane that is not ready', () => {
    const pr = { no: 80, url: 'u', title: 't', checks: 'failure', merged: false, files: 1, add: 1, del: 0 } as unknown as Lane['pr'];
    const why = { ...notReady, why: 'checks are failure' };
    expect(computeNext({ ...base, state: 'done', pr } as Lane, why)).toBe('Not ready to merge yet: checks are failure. Re-check once that clears.');
  });

  it('never answers a bare state word', () => {
    for (const state of ['running', 'handed-off', 'paused', 'parked', 'blocked', 'exhausted', 'unverified', 'done', 'merged', 'killed'] as const) {
      const next = computeNext({ ...base, state } as Lane, notReady);
      expect(next.length).toBeGreaterThan(20);
      expect(next).not.toBe(state);
    }
  });

  it('is on every summary', () => {
    const summary = computeLaneSummary({
      lane: { plain: 'p', mergeable: { ok: false, why: 'no PR yet' }, state: 'killed', retiredAt: null, runaway: false, pr: null, question: null } as unknown as Lane,
      story: null, pr: null, attestation: null, drift: noDrift(),
    });
    expect(summary.next).toMatch(/^Reopen it/);
  });
});
