/**
 * Requirement: redact every packet, journal row, and PR body before it reaches disk or a
 * sink -- three unredacted sinks were named as a live finding
 * (`2026-09-04-forge-spine-sdk-workers.md:854-856`). Applies the `redact` function
 * contracts.ts already declares (used elsewhere for gotcha files and exec dumps) to
 * Council's own three sinks, rather than leaving Council to reinvent its own pattern
 * list.
 */
import { redact } from '../contracts.ts';
import type { CouncilAttestation, CouncilFinding, CouncilLensReport } from '../contracts.ts';

function redactFinding(finding: CouncilFinding): CouncilFinding {
  return {
    ...finding,
    claim: redact(finding.claim),
    failureScenario: redact(finding.failureScenario),
  };
}

/** Sink 1: a lens's own packet, before it is written or handed to the judge. `rawReply`
 *  (I19) only exists on a lens that failed to parse, and it is the model's own raw text,
 *  so it goes through the same redaction as everything else here before it can reach
 *  disk. */
export function redactLensReport(report: CouncilLensReport): CouncilLensReport {
  return {
    ...report,
    findings: report.findings.map(redactFinding),
    ...(report.rawReply !== undefined ? { rawReply: redact(report.rawReply) } : {}),
  };
}

/** Sink 2: an attestation, before it becomes a journal row on disk. */
export function redactAttestationForJournal(attestation: CouncilAttestation): CouncilAttestation {
  return {
    ...attestation,
    decidingFindings: attestation.decidingFindings.map(redactFinding),
    lenses: attestation.lenses.map(redactLensReport),
    codex: attestation.codex ? { ...attestation.codex, findings: attestation.codex.findings.map(redactFinding) } : attestation.codex,
  };
}

/** Sink 3: the PR body Council writes for the RN merge or the backend draft. */
export function redactPrBody(body: string): string {
  return redact(body);
}
