/**
 * Roadmap P4.4, acceptance specimens 1 and 2. Three isolated Sonnet lenses each write
 * their own packet (Section 5 of the spec: "an isolated findings packet"), and Codex runs
 * the same rubric read-only. Synthesis reconciles them into the blocking set without a
 * model call: a claim from exactly one lens, with nothing corroborating it and no strong
 * confidence behind it, is not treated as confirmed just because a lens said so. A
 * Codex-only finding is never silently dropped either; it is carried forward tagged
 * contested, so a reviewer sees it and can accept or refute it in writing.
 */
import type { CouncilFinding, CouncilLensReport } from '../contracts.ts';

export interface SynthesisResult {
  /** What actually blocks the merge (the judge reads only this plus the packets). */
  decidingFindings: CouncilFinding[];
  /** Codex raised it, no Sonnet lens found the same spot: contested, not dropped. */
  codexOnly: CouncilFinding[];
  allFindings: CouncilFinding[];
}

const keyOf = (f: CouncilFinding) => `${f.file}:${f.line}`;

export const SEVERITY_RANK: Record<CouncilFinding['severity'], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/**
 * A single lens's claim clears the blocking bar on its own only when it is both high
 * confidence and at least high severity; anything softer needs a second lens (or Codex)
 * landing on the same file:line before it counts as confirmed. This is the rule the
 * seeded-false-finding specimen exists to prove: a low-confidence, single-lens claim
 * never reaches `decidingFindings`.
 */
function clearsSoloBar(finding: CouncilFinding): boolean {
  return finding.confidence === 'high' && SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.high;
}

export function synthesizeFindings(
  lensReports: CouncilLensReport[],
  codexFindings: CouncilFinding[] = [],
): SynthesisResult {
  const lensFindings = lensReports.flatMap((r) => r.findings);
  const decidingFindings: CouncilFinding[] = [];

  for (const finding of lensFindings) {
    const corroborated = lensFindings.some((other) => other !== finding && keyOf(other) === keyOf(finding));
    if (corroborated || clearsSoloBar(finding)) decidingFindings.push(finding);
  }

  const codexOnly: CouncilFinding[] = [];
  for (const codexFinding of codexFindings) {
    const matchesLens = lensFindings.some((f) => keyOf(f) === keyOf(codexFinding));
    if (matchesLens) {
      decidingFindings.push(codexFinding);
    } else {
      codexOnly.push({
        ...codexFinding,
        contested: codexFinding.contested ?? {
          by: 'synthesis',
          reason: 'Codex-only finding with no matching Sonnet lens finding; carried forward rather than dropped.',
        },
      });
    }
  }

  return { decidingFindings, codexOnly, allFindings: [...lensFindings, ...codexFindings] };
}
