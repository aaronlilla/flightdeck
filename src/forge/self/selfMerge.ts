/**
 * `selfMergeAllowed`: whether a self-repo item may merge itself once its gate is green
 * (Aaron, 2026-09-07 11:40). Pure policy -- no `gh` call, no journal write, no file read.
 * The actual merge, when this says yes, reuses `mergeItem` from `intake/queue.ts`
 * unchanged: this module decides, `mergeItem` acts.
 *
 * Every clause is a separate, named refusal rather than one boolean, because "the gate
 * failed" tells a person nothing and "coverage was 3 of 4, missing scope-conformance"
 * tells them exactly what to look at.
 */
import type { CouncilVerdict } from '../contracts.js';
import { mergeItem, type QueueMergeDeps, type QueueMergeResult } from '../intake/queue.js';
import type { QueueItem } from '../../shared/console-model.js';

const CLEARS_GATE: CouncilVerdict[] = ['PASS', 'PASS WITH NOTES'];

/**
 * Paths whose change means this PR touched Forge's own runtime, not just its notes,
 * skills or tests -- named verbatim from the brief: sdkengine, worker, runinbox, inbox,
 * launcher, exec, adapter/engine, chain-wire, cli. A match on any of these means a
 * regular council pass is not enough; a live probe run has to have exited 0 first.
 */
const RUNTIME_PATH_PATTERNS: RegExp[] = [
  /sdkengine/i,
  /worker/i,
  /runinbox/i,
  /inbox/i,
  /launcher/i,
  /exec/i,
  /adapter[\\/]engine/i,
  /chain-wire/i,
  /(^|[\\/])cli\.ts$/i,
];

export function isRuntimePathChange(changedFiles: string[]): boolean {
  return changedFiles.some((file) => RUNTIME_PATH_PATTERNS.some((pattern) => pattern.test(file)));
}

export interface SelfMergeAttestation {
  verdict: CouncilVerdict;
  coverage: { total: number; missing: string[] };
}

export interface SelfMergeChecks {
  conclusion: 'success' | 'failure' | 'pending';
}

export interface SelfMergePolicyInput {
  repo: string;
  selfRepo: string;
  /** `FORGE_SELF_MERGE === '1'`. Read by the caller, passed in as a boolean so this
   *  stays a pure function of its arguments. */
  selfMergeEnabled: boolean;
  attestation: SelfMergeAttestation | undefined;
  checks: SelfMergeChecks | undefined;
  changedFiles: string[];
  /** Whether `FORGE_SELF_PROBE_CMD` (run by the caller, never by this module) exited 0,
   *  read from whatever result file the caller defines. `undefined` means no probe ran
   *  at all -- indistinguishable from "failed" for a runtime-path change, since a merge
   *  gate that cannot tell "never ran" from "ran and failed" is not a gate. */
  probeOk: boolean | undefined;
}

export type SelfMergeDecision = { ok: true } | { ok: false; reason: string };

/** The exact coverage total a self-merge requires: every council member answered, none
 *  missing. Named as a constant because the brief states it as a number, not "all of
 *  whatever the round happened to require". */
const REQUIRED_COVERAGE_TOTAL = 4;

export function selfMergeAllowed(input: SelfMergePolicyInput): SelfMergeDecision {
  if (input.repo !== input.selfRepo) {
    return { ok: false, reason: `${input.repo} is not the configured self repo (${input.selfRepo || 'unset'})` };
  }
  if (!input.selfMergeEnabled) {
    return { ok: false, reason: 'FORGE_SELF_MERGE is not set to 1' };
  }
  if (!input.attestation) {
    return { ok: false, reason: 'no council attestation is on record for this head' };
  }
  if (!CLEARS_GATE.includes(input.attestation.verdict)) {
    return { ok: false, reason: `council verdict is ${input.attestation.verdict}, not PASS or PASS WITH NOTES` };
  }
  if (input.attestation.coverage.missing.length > 0) {
    return { ok: false, reason: `coverage is missing: ${input.attestation.coverage.missing.join(', ')}` };
  }
  if (input.attestation.coverage.total !== REQUIRED_COVERAGE_TOTAL) {
    return {
      ok: false,
      reason: `coverage total is ${input.attestation.coverage.total}, not the required ${REQUIRED_COVERAGE_TOTAL}`,
    };
  }
  if (!input.checks || input.checks.conclusion !== 'success') {
    return { ok: false, reason: `PR checks are ${input.checks?.conclusion ?? 'unknown'}, not success` };
  }
  if (isRuntimePathChange(input.changedFiles) && input.probeOk !== true) {
    return {
      ok: false,
      reason: input.probeOk === false
        ? 'this PR touches a runtime-path file and the live probe failed'
        : 'this PR touches a runtime-path file and no live probe result is on record',
    };
  }
  return { ok: true };
}

/**
 * Applies `selfMergeAllowed`'s decision: on `ok`, calls `mergeItem` (`intake/queue.ts`)
 * unchanged, the same click path an operator's own Merge button uses. On a refusal,
 * `mergeItem` is never called at all -- the reason is journaled and returned, and the
 * item is left exactly where it was for a person to look at.
 */
export async function runSelfMerge(
  item: QueueItem,
  policyInput: SelfMergePolicyInput,
  mergeDeps: QueueMergeDeps,
  append: (event: Record<string, unknown>) => { id: string },
): Promise<QueueMergeResult> {
  const decision = selfMergeAllowed(policyInput);
  if (!decision.ok) {
    append({ event: 'self.merge-refused', actor: 'self', itemId: item.id, reason: decision.reason });
    return { ok: false, message: decision.reason };
  }
  const result = await mergeItem(item, mergeDeps);
  append({
    event: result.ok ? 'self.merged' : 'self.merge-refused', actor: 'self', itemId: item.id,
    message: result.message,
  });
  return result;
}
