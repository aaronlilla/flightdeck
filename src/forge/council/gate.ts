/**
 * The merge gates, acceptance specimens 3, 5, 6, 10. Every function here is pure: no
 * model call, no `gh` invocation. The caller (Council's runner) supplies the judge's
 * verdict, the Codex verdict, and the CI check it read, and these functions turn that
 * into a decision plus, for the RN path, the exact `gh pr merge` call to make.
 */
import type { CouncilFinding, CouncilLensReport, CouncilVerdict } from '../contracts.ts';

const CLEARS_GATE: CouncilVerdict[] = ['PASS', 'PASS WITH NOTES'];

// -------------------------------------------------------------------------------------
// The judge's input: packets, brief, CI state -- never the raw diff (specimen 3)
// -------------------------------------------------------------------------------------

export interface JudgeInput {
  lenses: CouncilLensReport[];
  brief: string;
  ci: { runId: string; headSha: string };
}

/**
 * Strips the raw diff out of whatever the caller has on hand. The type signature alone
 * does not prove this (a caller could still read `.diff` off its own source object), so
 * the acceptance specimen asserts the built input has no `diff` key and does not contain
 * the diff's own text, which is what a spy on a fake judge call would actually see.
 */
export function buildJudgeInput(source: {
  lenses: CouncilLensReport[];
  brief: string;
  ci: { runId: string; headSha: string };
  diff: string;
}): JudgeInput {
  return { lenses: source.lenses, brief: source.brief, ci: source.ci };
}

// -------------------------------------------------------------------------------------
// Judge/Codex reconciliation (decision 6): no Fable call anywhere in Council
// -------------------------------------------------------------------------------------

/**
 * "Fable only when judge and Codex disagree on plan conformance" (spec) is superseded by
 * decision 6: no Fable call anywhere in Council, because Fable is barred from
 * Agent/Workflow fan-out and Council runs unattended. A disagreement resolves to `FIX
 * FIRST` instead of a third opinion. `PASS` and `PASS WITH NOTES` both clear the gate, so
 * that pair is not a disagreement worth a fix round; the stricter of the two wins.
 */
export function reconcileJudgeAndCodex(judgeVerdict: CouncilVerdict, codexVerdict: CouncilVerdict | undefined): CouncilVerdict {
  if (codexVerdict === undefined) return judgeVerdict;
  if (judgeVerdict === codexVerdict) return judgeVerdict;
  const bothClear = CLEARS_GATE.includes(judgeVerdict) && CLEARS_GATE.includes(codexVerdict);
  if (bothClear) {
    return judgeVerdict === 'PASS WITH NOTES' || codexVerdict === 'PASS WITH NOTES' ? 'PASS WITH NOTES' : 'PASS';
  }
  return 'FIX FIRST';
}

// -------------------------------------------------------------------------------------
// RN merge gate (specimen 5): judge PASS, Codex PASS, checks green ON THE HEAD BEING MERGED
// -------------------------------------------------------------------------------------

export interface CiCheck {
  runId: string;
  headSha: string;
  conclusion: 'success' | 'failure' | 'pending';
}

export interface RnGateInput {
  judgeVerdict: CouncilVerdict;
  codexVerdict: CouncilVerdict;
  ci: CiCheck;
  currentHeadSha: string;
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

/**
 * `gh-pr-checks-watch-reports-stale-run` memory note: `--watch` can print a finished run
 * for the *previous* head and exit 0 before the new run even registers. This is why the
 * gate compares `ci.headSha` against `currentHeadSha` rather than trusting `conclusion`
 * alone -- a green conclusion on the wrong head is not a green conclusion on this PR.
 */
export function rnMergeGate(input: RnGateInput): GateDecision {
  if (!CLEARS_GATE.includes(input.judgeVerdict)) {
    return { allow: false, reason: `judge verdict is ${input.judgeVerdict}, not PASS or PASS WITH NOTES` };
  }
  if (!CLEARS_GATE.includes(input.codexVerdict)) {
    return { allow: false, reason: `Codex verdict is ${input.codexVerdict}, not PASS or PASS WITH NOTES` };
  }
  if (input.ci.headSha !== input.currentHeadSha) {
    return {
      allow: false,
      reason: `CI check run ${input.ci.runId} is for head ${input.ci.headSha}, but the PR's ` +
        `current head is ${input.currentHeadSha}: a stale run, not a current one`,
    };
  }
  if (input.ci.conclusion !== 'success') {
    return { allow: false, reason: `CI conclusion is ${input.ci.conclusion}, not success` };
  }
  return { allow: true };
}

// -------------------------------------------------------------------------------------
// Backend gate (specimen 6): draft PR, ping, never a merge call
// -------------------------------------------------------------------------------------

export interface BackendGateInput {
  judgeVerdict: CouncilVerdict;
  codexVerdict: CouncilVerdict;
  ci: CiCheck;
}

export interface BackendGateResult {
  action: 'open-draft-pr';
  decidingFindings?: CouncilFinding[];
}

/**
 * No branch of this function ever returns a merge action, and it accepts the same green
 * inputs `rnMergeGate` would accept, on purpose: the backend gate ends at "draft PR open,
 * owner pinged" regardless of how green the audit is, because the gitflow guard makes a
 * merge to a controlled repo mechanically impossible. This function does not even have
 * an output shape a caller could interpret as authorizing one.
 */
export function backendGate(_input: BackendGateInput): BackendGateResult {
  return { action: 'open-draft-pr' };
}

// -------------------------------------------------------------------------------------
// Squash merge call (specimen 10): explicit subject/body, never GitHub's default
// -------------------------------------------------------------------------------------

export interface SquashMergeInput {
  commits: string[];
  subject: string;
  body: string;
}

export interface SquashMergeCall {
  subject: string;
  body: string;
  args: string[];
}

/**
 * `squash-merge-message-breaks-slack-notify` memory note: GitHub's default squash body
 * concatenates every commit message, which on a ten-commit branch blew Slack's 3000-char
 * block limit and failed the deploy notify silently. This never touches `commits` beyond
 * accepting them as context; the subject and body the caller passed in are what reach the
 * command line, always explicit, never derived from the commit list.
 */
export function buildSquashMergeCall(input: SquashMergeInput): SquashMergeCall {
  return {
    subject: input.subject,
    body: input.body,
    args: ['pr', 'merge', '--squash', '--subject', input.subject, '--body', input.body],
  };
}
