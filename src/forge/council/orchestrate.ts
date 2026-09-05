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
    ? await roles.codexLane.run({ brief: input.brief, diffSummary: input.diffSummary })
    : { ran: false, findings: [] };

  const synthesis = synthesizeFindings(lensReports, codexResult.findings);

  const judgeInput = buildJudgeInput({
    lenses: lensReports,
    brief: input.brief,
    ci: input.ci,
    diff: input.diffSummary,
  });
  const judgment = await roles.judge.decide(judgeInput);

  return {
    lensReports,
    codexRan: codexResult.ran,
    decidingFindings: judgment.decidingFindings.length ? judgment.decidingFindings : synthesis.decidingFindings,
    codexOnly: synthesis.codexOnly,
    verdict: judgment.verdict,
  };
}
