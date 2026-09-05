/**
 * The three roles Section 5 of the spec names: three Sonnet lenses, a read-only Codex
 * lane on the same rubric, and an Opus judge. Each is an interface here, never a concrete
 * model-backed implementation -- this stream builds the gate the roles plug into, not the
 * roles themselves. Guardrail: no model call and no Codex call anywhere in this repo's
 * tests, so every specimen drives these interfaces through a fake, never the real thing.
 */
import type { CouncilFinding, CouncilLensReport, CouncilVerdict } from '../contracts.ts';
import type { JudgeInput } from './gate.ts';

export interface LensInput {
  lens: string;
  brief: string;
  diffSummary: string;
}

export interface LensRunner {
  run(input: LensInput): Promise<CouncilLensReport>;
}

export interface CodexLaneResult {
  ran: boolean;
  findings: CouncilFinding[];
}

export interface CodexLaneInput {
  brief: string;
  diffSummary: string;
}

/**
 * Read-only, same rubric as the Sonnet lenses. The real implementation is a call through
 * `dev-harness/tools/codex_call.py` (`codex-side-agent` memory note); this interface is
 * what lets Council's gate stay ignorant of that mechanics entirely.
 */
export interface CodexLane {
  run(input: CodexLaneInput): Promise<CodexLaneResult>;
}

export interface JudgeResult {
  verdict: CouncilVerdict;
  decidingFindings: CouncilFinding[];
}

/**
 * `2026-09-04-forge-spine-sdk-workers.md:143-145`: reads packets, brief and CI state,
 * never the whole diff. `buildJudgeInput` (gate.ts) is what enforces the "never the whole
 * diff" half; this interface only ever receives that already-stripped `JudgeInput`.
 */
export interface Judge {
  decide(input: JudgeInput): Promise<JudgeResult>;
}
