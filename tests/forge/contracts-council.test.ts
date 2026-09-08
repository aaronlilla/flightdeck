/**
 * Council's additions to contracts.ts: the attestation that binds a verdict to a
 * head/base sha pair, and the three typed human handoffs. No model call, no `gh` write:
 * every input here is a fabricated fixture.
 */
import { describe, expect, it } from 'vitest';

import {
  attestationCoversHead,
  CouncilAttestationSchema,
  checkHandoff,
  HaipingHandoffSchema,
  haipingHandoffExample,
  JoeHandoffSchema,
  HarrisonHandoffSchema,
  verified,
} from '../../src/forge/contracts.ts';
import type { CouncilAttestation } from '../../src/forge/contracts.ts';

function fixtureAttestation(overrides: Partial<CouncilAttestation> = {}): CouncilAttestation {
  return {
    repo: 'sample-app',
    pr: 42,
    head: 'aaaaaaa',
    base: 'bbbbbbb',
    round: 1,
    verdict: 'PASS',
    decidingFindings: [],
    lenses: [
      { lens: 'correctness', findings: [] },
      { lens: 'regression-risk', findings: [] },
      { lens: 'scope-conformance', findings: [] },
    ],
    judge: { model: 'claude-opus-5', verdict: 'PASS' },
    ci: { runId: 'run-1', headSha: 'aaaaaaa' },
    at: verified(Date.now(), 'journal:council.attested'),
    coverage: { total: 3, missing: [] },
    ...overrides,
  };
}

describe('CouncilAttestation', () => {
  it('a well-formed attestation validates', () => {
    const result = CouncilAttestationSchema.safeParse(fixtureAttestation());
    expect(result.success).toBe(true);
  });

  it('falsifier 7: an attestation for the same head/base is recognizable as the same pair', () => {
    const a = fixtureAttestation();
    const b = fixtureAttestation();
    expect(attestationCoversHead(a, { head: b.head, base: b.base })).toBe(true);
  });

  it('falsifier 7: a moved head is never mistaken for the old verdict', () => {
    const stored = fixtureAttestation({ head: 'aaaaaaa' });
    expect(attestationCoversHead(stored, { head: 'ccccccc', base: stored.base })).toBe(false);
  });

  it('falsifier 7: a moved base is never mistaken for the old verdict', () => {
    const stored = fixtureAttestation({ base: 'bbbbbbb' });
    expect(attestationCoversHead(stored, { head: stored.head, base: 'ddddddd' })).toBe(false);
  });

  it('rejects a verdict outside the three-value enum', () => {
    const bad = { ...fixtureAttestation(), verdict: 'MAYBE' };
    expect(CouncilAttestationSchema.safeParse(bad).success).toBe(false);
  });
});

describe('typed handoffs: an incomplete one fails the gate', () => {
  it('a complete Haiping handoff passes', () => {
    const result = checkHandoff('haiping', {
      ticket: 'BBZ-100',
      pr: '#42',
      deployKind: 'ota',
      perPlatform: { android: 'published', ios: 'published' },
      steps: ['open the app', 'go to wallet'],
      notVisuallyVerified: ['dark mode'],
    });
    expect(result.complete).toBe(true);
  });

  it('a Haiping handoff missing perPlatform fails the gate and names the field', () => {
    const result = checkHandoff('haiping', {
      ticket: 'BBZ-100',
      pr: '#42',
      deployKind: 'ota',
      steps: ['open the app'],
      notVisuallyVerified: [],
    });
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.missing.join(',')).toContain('perPlatform');
  });

  it('a complete Joe handoff passes', () => {
    const result = checkHandoff('joe', {
      ticket: 'BBZ-101',
      draftPr: '#7',
      packets: [{ lens: 'correctness', findings: [] }],
      howToRun: 'dotnet test',
      couldNotRun: [],
    });
    expect(JoeHandoffSchema.safeParse(result).success || result.complete).toBeTruthy();
    expect(result.complete).toBe(true);
  });

  it('a Joe handoff with no packets fails the gate', () => {
    const result = checkHandoff('joe', {
      ticket: 'BBZ-101',
      draftPr: '#7',
      packets: [],
      howToRun: 'dotnet test',
      couldNotRun: [],
    });
    expect(result.complete).toBe(false);
  });

  it('a complete Harrison handoff passes without decisionNeeded', () => {
    const result = checkHandoff('harrison', {
      ticket: 'BBZ-102',
      summaryInAaronsVoice: 'shipped the retry fix',
    });
    expect(result.complete).toBe(true);
  });

  it('a Harrison handoff with an empty summary fails the gate', () => {
    const result = checkHandoff('harrison', { ticket: 'BBZ-102', summaryInAaronsVoice: '' });
    expect(result.complete).toBe(false);
  });

  it('schemas themselves reject the same incomplete shapes directly', () => {
    expect(HaipingHandoffSchema.safeParse({ ticket: 'x' }).success).toBe(false);
    expect(HarrisonHandoffSchema.safeParse({}).success).toBe(false);
  });
});

describe('haipingHandoffExample: the placeholder a worker copies into the PR body', () => {
  it('parses as complete JSON against the real schema, not a hand-written duplicate of it', () => {
    const parsed = JSON.parse(haipingHandoffExample());
    expect(checkHandoff('haiping', parsed).complete).toBe(true);
  });

  it('is plain JSON text -- the caller fences it, so this stays reusable outside a fence', () => {
    expect(haipingHandoffExample().trim().startsWith('```')).toBe(false);
    expect(() => JSON.parse(haipingHandoffExample())).not.toThrow();
  });
});
