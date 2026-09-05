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
import { buildJudgeInput } from './gate.ts';
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
  lensReports: CouncilLensReport[];
  codexRan: boolean;
  decidingFindings: CouncilFinding[];
  codexOnly: CouncilFinding[];
  verdict: CouncilVerdict;
}

export async function runCouncilRound(input: CouncilRoundInput, roles: CouncilRoles): Promise<CouncilRoundResult> {
  const risk = diffRisk({ changedLines: input.changedLines, paths: input.paths });
  const lensCount = lensCountFor(risk);
  const lensNames = LENS_NAMES.slice(0, lensCount);

  const lensReports = await Promise.all(
    lensNames.map((lens) => roles.lensRunner.run({ lens, brief: input.brief, diffSummary: input.diffSummary })),
  );

  const codexResult = (input.forceCodex || risk.needsCodex)
    ? await roles.codexLane.run({
        brief: input.brief, diffSummary: input.diffSummary, cwd: input.cwd, baseRef: input.baseRef,
      })
    : { ran: false, findings: [] };

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

  const judgeLensReports = gapFinding ? [...lensReports, { lens: 'codex', findings: [gapFinding] }] : lensReports;

  const synthesis = synthesizeFindings(lensReports, codexResult.findings);

  const judgeInput = buildJudgeInput({
    lenses: judgeLensReports,
    brief: input.brief,
    ci: input.ci,
    diff: input.diffSummary,
  });
  const judgment = await roles.judge.decide(judgeInput);

  const decidingFindings = judgment.decidingFindings.length ? judgment.decidingFindings : synthesis.decidingFindings;

  return {
    lensReports,
    codexRan: codexResult.ran,
    decidingFindings: gapFinding ? [...decidingFindings, gapFinding] : decidingFindings,
    codexOnly: synthesis.codexOnly,
    verdict: gapFinding ? 'FIX FIRST' : judgment.verdict,
  };
}
