/**
 * Composes the lens/judge roles into one council round: scale to diff risk, run the
 * lenses, synthesize, hand the judge the packets-only input, and decide. No fix-round
 * looping here -- `rounds.ts`'s `evaluateFixRounds` is the pure state machine for that
 * (superseded in practice by `queue.ts`'s iterate-until-clean loop), driven by whatever
 * calls this function once per round.
 *
 * Aaron, 2026-09-23 (standing order, full autonomous mode): every review member this
 * round runs is `claude`/`opus-5-5` (`model-policy.json`'s `audit-lens`/`audit-judge`
 * classes) -- there is no Codex lane here any more, and `FORGE_COUNCIL_CODEX` is read
 * nowhere in this file. A round never asks Codex to run, never requires it for coverage,
 * and never blocks on it being missing. `CouncilRoundInput.forceCodex` is accepted and
 * silently ignored for backward compatibility with existing callers (`chain.ts`,
 * `queue.ts`) that still pass it -- those call sites can drop the field once they are
 * next touched, but leaving it here costs nothing and keeps this a data-only change for
 * them.
 */
import { LENS_NAMES } from './lenses.ts';
import { diffRisk, lensCountFor } from './risk.ts';
import { synthesizeFindings } from './synthesis.ts';
import { buildJudgeInput, verdictForRound } from './gate.ts';
import type { Judge, LensRunner } from './roles.ts';
import type { CouncilLensReport, CouncilVerdict, CouncilFinding } from '../contracts.ts';

export interface CouncilRoundInput {
  brief: string;
  diffSummary: string;
  changedLines: number;
  paths: string[];
  ci: { runId: string; headSha: string };
  /** Ignored (2026-09-23): the council no longer has a Codex lane. Accepted only so a
   *  caller still passing it (`FORGE_COUNCIL_CODEX=always`) does not need editing. */
  forceCodex?: boolean;
  /** No longer read by this file -- kept on the input shape for the same reason as
   *  `forceCodex`, since some callers still pass them through from a Codex-era call. */
  cwd?: string;
  baseRef?: string;
}

export interface CouncilRoles {
  lensRunner: LensRunner;
  judge: Judge;
}

export interface CouncilRoundResult {
  /** Every lens's final report, after its one retry -- `failed`/`rawReply`/`retried`
   *  intact, recorded honestly the same as before this round could ever act on it. */
  lensReports: CouncilLensReport[];
  /** Always `false` (2026-09-23): kept on the result shape so `cli.ts`'s existing
   *  `CouncilAttestation.codex` write stays a no-op instead of needing its own edit. */
  codexRan: boolean;
  decidingFindings: CouncilFinding[];
  /** Always empty (2026-09-23), for the same reason as `codexRan`. */
  codexOnly: CouncilFinding[];
  verdict: CouncilVerdict;
  /** GATE.md items 1 and 4: names of every lens that never returned a usable reply after
   *  its one retry. Empty means full coverage. This is what `verdictForRound` (`gate.ts`)
   *  actually decides on -- never a finding handed to the judge, because a missing
   *  reviewer is not a quality signal. */
  missingMembers: string[];
  /** How many members this round required in total (the lenses run) --
   *  `membersTotal - missingMembers.length` is how many actually answered, the
   *  "reviewed by N of M" a board can show. */
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

  // GATE.md item 1: a failed lens is coverage, not a code-quality claim -- it is excluded
  // from what the judge reads entirely, never handed over dressed up as a finding for it
  // to weigh.
  const usableLensReports = lensReports.filter((report) => !report.failed);

  const synthesis = synthesizeFindings(usableLensReports, []);

  // C.2: an Opus judge call is the round's single most expensive step. A round with no
  // finding anywhere in what the judge would read has nothing to weigh -- `PASS` here
  // costs no call, and `verdictForRound` below still tightens it to `FIX FIRST` on its
  // own if coverage is short, exactly as it would have if the judge had said `PASS` too.
  const hasJudgeableFinding = usableLensReports.some((report) => report.findings.length > 0);
  const judgment = hasJudgeableFinding
    ? await roles.judge.decide(buildJudgeInput({
        lenses: usableLensReports,
        brief: input.brief,
        ci: input.ci,
        diff: input.diffSummary,
      }))
    : { verdict: 'PASS' as CouncilVerdict, decidingFindings: [] as CouncilFinding[] };

  const missingMembers = lensReports.filter((report) => report.failed).map((report) => report.lens);
  const membersTotal = lensNames.length;
  const verdict = verdictForRound(judgment.verdict, { missingMembers });

  let decidingFindings = judgment.decidingFindings.length ? judgment.decidingFindings : synthesis.decidingFindings;
  if (missingMembers.length > 0) {
    decidingFindings = [...decidingFindings, coverageFinding(missingMembers, membersTotal - missingMembers.length, membersTotal)];
  }

  return {
    lensReports,
    codexRan: false,
    decidingFindings,
    codexOnly: [],
    verdict,
    missingMembers,
    membersTotal,
  };
}
