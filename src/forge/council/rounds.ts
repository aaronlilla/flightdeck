/**
 * Roadmap P4.4, acceptance specimen 4. Three `FIX FIRST` verdicts re-enter the worker;
 * a fourth is never allowed to happen. This is pure and takes a fixed sequence of round
 * results rather than driving the worker itself, so a test can hand it a fabricated
 * stream with no model call.
 */
import type { CouncilFinding, CouncilVerdict } from '../contracts.ts';

export interface RoundResult {
  round: number;
  verdict: CouncilVerdict;
  findings: CouncilFinding[];
}

export interface FixRoundOutcome {
  parked: boolean;
  packet: CouncilFinding[] | null;
  /** How many rounds were actually looked at before the loop stopped. */
  enteredRounds: number;
}

const MAX_FIX_ROUNDS = 3;

export function evaluateFixRounds(rounds: RoundResult[]): FixRoundOutcome {
  let consecutiveFixFirst = 0;
  let enteredRounds = 0;

  for (const result of rounds) {
    enteredRounds += 1;
    if (result.verdict !== 'FIX FIRST') {
      return { parked: false, packet: null, enteredRounds };
    }
    consecutiveFixFirst += 1;
    if (consecutiveFixFirst >= MAX_FIX_ROUNDS) {
      return { parked: true, packet: result.findings, enteredRounds };
    }
  }

  return { parked: false, packet: null, enteredRounds };
}
