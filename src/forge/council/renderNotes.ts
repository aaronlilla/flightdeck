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
