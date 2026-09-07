/**
 * Requirement: "Redact every packet, journal row and PR body before it reaches disk or a
 * sink" -- three unredacted sinks were a named live finding
 * (`2026-09-04-forge-spine-sdk-workers.md:854-856`). This proves the three council-owned
 * sinks (a lens packet, an attestation journal row, a PR body) all run through the
 * existing `redact` function from contracts.ts before they would be written.
 */
import { describe, expect, it } from 'vitest';

import { redactLensReport, redactPrBody, redactAttestationForJournal } from '../../../src/forge/council/redact-sinks.ts';
import type { CouncilAttestation, CouncilLensReport } from '../../../src/forge/contracts.ts';
import { verified } from '../../../src/forge/contracts.ts';

const SECRET = 'AKIAABCDEFGHIJKLMNOP';

function attestation(): CouncilAttestation {
  return {
    repo: 'sample-app',
    pr: 1,
    head: 'a',
    base: 'b',
    round: 1,
    verdict: 'PASS',
    decidingFindings: [
      { member: 'correctness', file: 'x.ts', line: 1, claim: `leaked key ${SECRET}`, failureScenario: 'n/a', severity: 'low', confidence: 'low' },
    ],
    lenses: [],
    judge: { model: 'claude-opus-5', verdict: 'PASS' },
    ci: { runId: 'r', headSha: 'a' },
    at: verified(Date.now(), 'test'),
    coverage: { total: 0, missing: [] },
  };
}

describe('redact-sinks: packet, journal row, PR body', () => {
  it('redacts a secret out of a lens report finding before it is a packet', () => {
    const report: CouncilLensReport = {
      lens: 'correctness',
      findings: [{ member: 'correctness', file: 'x.ts', line: 1, claim: `token ${SECRET} leaked`, failureScenario: 'n/a', severity: 'low', confidence: 'low' }],
    };
    const cleaned = redactLensReport(report);
    expect(JSON.stringify(cleaned)).not.toContain(SECRET);
  });

  it('redacts a secret out of an attestation before it becomes a journal row', () => {
    const cleaned = redactAttestationForJournal(attestation());
    expect(JSON.stringify(cleaned)).not.toContain(SECRET);
  });

  it('redacts a secret out of a PR body', () => {
    const cleaned = redactPrBody(`Fixes the retry loop. Old token was ${SECRET}.`);
    expect(cleaned).not.toContain(SECRET);
  });

  it('leaves ordinary text untouched', () => {
    const report: CouncilLensReport = { lens: 'correctness', findings: [] };
    expect(redactLensReport(report)).toEqual(report);
  });
});
