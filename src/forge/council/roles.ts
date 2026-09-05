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
  /** Set whenever `ran` is `false`, so a caller can say why the lane never started rather
   *  than reading absence as silence. */
  reason?: string;
}

export interface CodexLaneInput {
  brief: string;
  diffSummary: string;
  /** A checkout whose HEAD is the PR head. Without this and `baseRef`, the lane never
   *  runs -- it returns `ran: false` with a reason instead of throwing. */
  cwd?: string;
  /** The PR's base branch. */
  baseRef?: string;
}

/**
 * Read-only, same rubric as the Sonnet lenses. The real implementation
 * (`codexLane.ts`) calls through `dev-harness/tools/codex_call.py`
 * (`codex-side-agent` memory note); this interface keeps Council's gate ignorant of
 * that mechanism entirely.
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
