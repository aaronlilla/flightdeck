/**
 * Roadmap P4.4, acceptance specimen 4, raised from 3 to 6 by Aaron's 2026-09-23 standing
 * order (full autonomous mode): the audit loop iterates FIX FIRST -> relaunch the worker
 * with the round's findings -> re-audit, repeating until PASS/PASS WITH NOTES, with this
 * as the safety cap. A seventh round is never entered; the item parks with the complete
 * findings history across every round it did run, so a person reads the whole story
 * rather than only the last attempt.
 */
import type { CouncilFinding, CouncilVerdict } from '../contracts.ts';

export interface RoundResult {
  round: number;
  verdict: CouncilVerdict;
  findings: CouncilFinding[];
}

export interface FixRoundOutcome {
  parked: boolean;
  /** The full findings history across every round this outcome parked on -- every
   *  round's own findings concatenated in order, not only the last round's, so a park
   *  after 6 rounds carries the whole story rather than just the final attempt. */
  packet: CouncilFinding[] | null;
  /** How many rounds were actually looked at before the loop stopped. */
  enteredRounds: number;
}

export const MAX_FIX_ROUNDS = 6;

export function evaluateFixRounds(rounds: RoundResult[]): FixRoundOutcome {
  let consecutiveFixFirst = 0;
  let enteredRounds = 0;
  const history: CouncilFinding[] = [];

  for (const result of rounds) {
    enteredRounds += 1;
    history.push(...result.findings);
    if (result.verdict !== 'FIX FIRST') {
      return { parked: false, packet: null, enteredRounds };
    }
    consecutiveFixFirst += 1;
    if (consecutiveFixFirst >= MAX_FIX_ROUNDS) {
      return { parked: true, packet: history, enteredRounds };
    }
  }

  return { parked: false, packet: null, enteredRounds };
}
