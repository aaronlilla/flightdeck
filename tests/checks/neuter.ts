/**
 * Mutation proof for the guard corpus.
 *
 * A green suite has two explanations: the guards work, or the assertions do
 * not. Standing order 6 says never trust a measurement whose sensor is built
 * from the thing under test, and a test suite grading its own guards is exactly
 * that shape.
 *
 * So this replaces each guard with a stub that always passes and requires the
 * corpus to notice. A guard whose corpus stays green while the guard does
 * nothing has no teeth, and the build fails rather than reporting a pass.
 */
import { authorshipGuard } from '../../src/kernel/guards/authorship.ts';
import { reviewPlan } from '../../src/kernel/guards/convergence.ts';
import { reviewTurns } from '../../src/kernel/guards/sycophancy.ts';
import { shouldClassify } from '../../src/kernel/guards/vagueness.ts';
import type { GuardDecision } from '../../src/types.ts';
import { AUTHORSHIP_SPECIMENS } from '../specimens/authorship.ts';
import { CONVERGENCE_SPECIMENS } from '../specimens/convergence.ts';
import { SYCOPHANCY_SPECIMENS } from '../specimens/sycophancy.ts';
import type { Verdict } from '../specimens/types.ts';
import { VAGUENESS_SPECIMENS } from '../specimens/vagueness.ts';

export function verdictOf(decision: GuardDecision): Verdict {
  if (decision.kind === 'deny') return 'deny';
  if (decision.kind === 'modify') return 'annotate';
  if (decision.kind === 'annotate') {
    return decision.notes.some((n) => n.severity === 'blocking') ? 'deny' : 'annotate';
  }
  return 'pass';
}

const PASS: GuardDecision = { kind: 'pass' };

export interface CorpusResult {
  guard: string;
  total: number;
  mismatches: string[];
}

/** Run one guard's corpus through whatever implementation is supplied. */
export function runAuthorship(decide: (call: never) => GuardDecision): CorpusResult {
  const mismatches: string[] = [];
  for (const specimen of AUTHORSHIP_SPECIMENS) {
    const got = verdictOf(decide(specimen.input as never));
    if (got !== specimen.expect) mismatches.push(`${specimen.name}: want ${specimen.expect}, got ${got}`);
  }
  return { guard: 'authorship', total: AUTHORSHIP_SPECIMENS.length, mismatches };
}

export function runConvergence(review: (plan: string) => GuardDecision): CorpusResult {
  const mismatches: string[] = [];
  for (const specimen of CONVERGENCE_SPECIMENS) {
    const got = verdictOf(review(specimen.input));
    if (got !== specimen.expect) mismatches.push(`${specimen.name}: want ${specimen.expect}, got ${got}`);
  }
  return { guard: 'convergence', total: CONVERGENCE_SPECIMENS.length, mismatches };
}

export function runSycophancy(review: (turns: never) => { kind: string }): CorpusResult {
  const mismatches: string[] = [];
  for (const specimen of SYCOPHANCY_SPECIMENS) {
    const verdict = review(specimen.input as never);
    const got = verdict.kind === 'block' ? 'block' : 'pass';
    if (got !== specimen.expect) mismatches.push(`${specimen.name}: want ${specimen.expect}, got ${got}`);
  }
  return { guard: 'sycophancy', total: SYCOPHANCY_SPECIMENS.length, mismatches };
}

export function runVagueness(decide: (prompt: string) => boolean): CorpusResult {
  const mismatches: string[] = [];
  for (const specimen of VAGUENESS_SPECIMENS) {
    const got = decide(specimen.input) ? 'classify' : 'skip';
    if (got !== specimen.expect) mismatches.push(`${specimen.name}: want ${specimen.expect}, got ${got}`);
  }
  return { guard: 'vagueness', total: VAGUENESS_SPECIMENS.length, mismatches };
}

/** The corpus against the guards as they actually are. */
export function runLive(): CorpusResult[] {
  return [
    runAuthorship((call) => authorshipGuard.decide?.(call, {} as never) ?? PASS),
    runConvergence(reviewPlan),
    runSycophancy(reviewTurns),
    runVagueness(shouldClassify),
  ];
}

/**
 * The corpus against guards that have been switched off. Each entry must report
 * mismatches, or that corpus is not testing anything.
 */
export function runNeutered(): CorpusResult[] {
  return [
    runAuthorship(() => PASS),
    runConvergence(() => PASS),
    runSycophancy(() => ({ kind: 'pass' })),
    // Neutering this one means never classifying, so every vague prompt slips
    // through untouched.
    runVagueness(() => false),
  ];
}
