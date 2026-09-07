/**
 * Composes the lens/Codex/judge roles into one council round: scale to diff risk, run the
 * lenses, run Codex only when the risk demands it, synthesize, hand the judge the
 * packets-only input, and decide. No fix-round looping here -- `rounds.ts`'s
 * `evaluateFixRounds` is the pure state machine for that, driven by whatever calls this
 * function once per round.
 */
import { LENS_NAMES } from './lenses.ts';
import { diffRisk, lensCountFor } from './risk.ts';
import { synthesizeFindings } from './synthesis.ts';
import { buildJudgeInput, verdictForRound } from './gate.ts';
import type { CodexLane, Judge, LensRunner } from './roles.ts';
import type { CouncilLensReport, CouncilVerdict, CouncilFinding } from '../contracts.ts';

export interface CouncilRoundInput {
  brief: string;
  diffSummary: string;
  changedLines: number;
  paths: string[];
  ci: { runId: string; headSha: string };
  /** P5.7: the chain's `FORGE_COUNCIL_CODEX=always` forces the Codex lane for this round
   *  regardless of what `diffRisk` would have decided on size and path alone. The lane
   *  itself still runs (or no-ops) per `codexLaneFor`'s own policy check -- this only
   *  overrides whether the round asks it to run at all. */
  forceCodex?: boolean;
  /** Forwarded to the Codex lane verbatim (`roles.ts`'s `CodexLaneInput`). Omitted for a
   *  round that never supplies them, which the lane itself reads as `ran: false`. */
  cwd?: string;
  baseRef?: string;
}

export interface CouncilRoles {
  lensRunner: LensRunner;
  codexLane: CodexLane;
  judge: Judge;
}

export interface CouncilRoundResult {
  /** Every lens's final report, after its one retry -- `failed`/`rawReply`/`retried`
   *  intact, recorded honestly the same as before this round could ever act on it. */
  lensReports: CouncilLensReport[];
  codexRan: boolean;
  decidingFindings: CouncilFinding[];
  codexOnly: CouncilFinding[];
  verdict: CouncilVerdict;
  /** GATE.md items 1 and 4: names of every lens (plus `'codex'`, when the round required
   *  it) that never returned a usable reply after its one retry. Empty means full
   *  coverage. This is what `verdictForRound` (`gate.ts`) actually decides on -- never a
   *  finding handed to the judge, because a missing reviewer is not a quality signal. */
  missingMembers: string[];
  /** How many members this round required in total (lenses run, plus the Codex lane
   *  when the diff's risk or the caller required it) -- `membersTotal - missingMembers.length`
   *  is how many actually answered, the "reviewed by N of M" a board can show. */
  membersTotal: number;
}

/** The one coverage finding a round adds when it cannot clear -- named once, for every
 *  missing member together, rather than one synthetic finding per lens. This is display
 *  only: `verdictForRound` has already decided the verdict from `missingMembers` itself,
 *  so this finding exists for a human reading the attestation, never for the judge, which
 *  never sees it (built after `roles.judge.decide` returns). */
function coverageFinding(missingMembers: string[], membersRan: number, membersTotal: number): CouncilFinding {
  return {
    member: 'council',
    file: '(coverage)',
    line: 0,
    claim: `round coverage incomplete: reviewed by ${membersRan} of ${membersTotal} `
      + `(${missingMembers.join(', ')} never returned a usable reply, even after a retry)`,
    failureScenario: 'this round cannot clear the gate on incomplete coverage, independent of what any '
      + 'lens or the judge found in the diff itself',
    severity: 'critical',
    confidence: 'high',
  };
}

export async function runCouncilRound(input: CouncilRoundInput, roles: CouncilRoles): Promise<CouncilRoundResult> {
  const risk = diffRisk({ changedLines: input.changedLines, paths: input.paths });
  const lensCount = lensCountFor(risk);
  const lensNames = LENS_NAMES.slice(0, lensCount);
  const lensCall = (lens: string) => roles.lensRunner.run({ lens, brief: input.brief, diffSummary: input.diffSummary });

  const firstAttempts = await Promise.all(lensNames.map(lensCall));

  // GATE.md item 2: a 120s timeout on a large diff is ordinary, and one retry is cheaper
  // than a person. Only the lenses that actually failed get a second attempt -- a lens
  // that already answered is never called twice.
  const lensReports = await Promise.all(firstAttempts.map(async (report) => {
    if (!report.failed) return report;
    const retry = await lensCall(report.lens);
    return { ...retry, retried: true };
  }));

  const codexRequired = Boolean(input.forceCodex) || risk.needsCodex;
  let codexResult = codexRequired
    ? await roles.codexLane.run({
        brief: input.brief, diffSummary: input.diffSummary, cwd: input.cwd, baseRef: input.baseRef,
      })
    : { ran: false, findings: [] };
  if (codexRequired && !codexResult.ran) {
    codexResult = await roles.codexLane.run({
      brief: input.brief, diffSummary: input.diffSummary, cwd: input.cwd, baseRef: input.baseRef,
    });
  }

  // A round the chain forced Codex onto (`FORGE_COUNCIL_CODEX=always`) where the lane
  // never actually ran is a silent gap, not a clean pass: three Sonnet lenses agreeing
  // proves nothing about the read-only rubric Codex was supposed to add. One uncovered
  // finding goes into the packet the judge reads, and the verdict is forced regardless
  // of what comes back, so a forced round can never clear on a lane that stayed silent.
  const codexRequiredButMissing = Boolean(input.forceCodex) && !('ran' in codexResult && codexResult.ran);
  const gapFinding: CouncilFinding | undefined = codexRequiredButMissing
    ? {
        member: 'codex',
        file: '(codex)',
        line: 0,
        claim: `Codex lane did not run: ${(codexResult as { reason?: string }).reason ?? 'no reason given'}`,
        failureScenario: 'the round required the Codex lane but it never ran, so this diff has no Codex '
          + 'coverage at all',
        severity: 'critical',
        confidence: 'high',
      }
    : undefined;

  // GATE.md item 1: a failed lens is coverage, not a code-quality claim -- it is excluded
  // from what the judge reads entirely, never handed over dressed up as a finding for it
  // to weigh. The Codex gap packet above is the one pre-existing exception to that rule
  // (forced rounds only) and is left as-is; `verdictForRound` still overrides its verdict.
  const usableLensReports = lensReports.filter((report) => !report.failed);
  const judgeLensReports = gapFinding
    ? [...usableLensReports, { lens: 'codex', findings: [gapFinding] }]
    : usableLensReports;

  const synthesis = synthesizeFindings(usableLensReports, codexResult.findings);

  const judgeInput = buildJudgeInput({
    lenses: judgeLensReports,
    brief: input.brief,
    ci: input.ci,
    diff: input.diffSummary,
  });
  const judgment = await roles.judge.decide(judgeInput);

  const missingMembers = [
    ...lensReports.filter((report) => report.failed).map((report) => report.lens),
    ...(codexRequired && !codexResult.ran ? ['codex'] : []),
  ];
  const membersTotal = lensNames.length + (codexRequired ? 1 : 0);
  const verdict = verdictForRound(judgment.verdict, { missingMembers });

  let decidingFindings = judgment.decidingFindings.length ? judgment.decidingFindings : synthesis.decidingFindings;
  if (gapFinding) decidingFindings = [...decidingFindings, gapFinding];
  if (missingMembers.length > 0) {
    decidingFindings = [...decidingFindings, coverageFinding(missingMembers, membersTotal - missingMembers.length, membersTotal)];
  }

  return {
    lensReports,
    codexRan: codexResult.ran,
    decidingFindings,
    codexOnly: synthesis.codexOnly,
    verdict,
    missingMembers,
    membersTotal,
  };
}
