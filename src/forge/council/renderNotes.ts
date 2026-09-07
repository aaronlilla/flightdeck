/**
 * A.2: the prose the queue posts as a PR comment before an item reaches `review` --
 * plain text a person reads on the pull request itself, not a second copy of the
 * attestation's own JSON. `queue.ts` never reads the attestation file (that module
 * touches no filesystem itself), so this takes the same summary shape `advanceItem`
 * already has in hand off the council result: a verdict, an optional coverage note
 * (GATE.md item 4's own gap-naming), and whatever findings text the council call
 * carried back.
 */
export interface CouncilNotesInput {
  verdict: string;
  coverageNote?: string;
  findingsText?: string;
}

export function renderNotes(input: CouncilNotesInput): string {
  const lines: string[] = [];
  lines.push(`Council verdict: ${input.verdict}.`);
  if (input.coverageNote) lines.push(`Coverage: ${input.coverageNote}.`);
  lines.push(input.findingsText?.trim() ? input.findingsText.trim() : 'No deciding findings.');
  return lines.join('\n');
}

/** The deciding findings of an attestation as the prose a reviewer reads on the PR:
 *  one line per finding with its member, severity, place and claim, then the failure
 *  scenario indented under it. Empty when the round decided on nothing. */
export function findingsTextFrom(attestation: {
  decidingFindings?: Array<{ member?: string; file?: string; line?: number; claim: string; failureScenario?: string; severity?: string; confidence?: string }>;
}): string {
  const NL = String.fromCharCode(10);
  const findings = attestation.decidingFindings ?? [];
  return findings.map((finding) => {
    const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
    const tag = [finding.severity, finding.confidence].filter(Boolean).join('/');
    const head = `- ${tag ? `[${tag}] ` : ''}${finding.member ? `${finding.member}: ` : ''}${finding.claim}${where}`;
    return finding.failureScenario ? `${head}${NL}  ${finding.failureScenario}` : head;
  }).join(NL);
}
