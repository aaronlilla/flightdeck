/**
 * Every guard, driven by the specimen corpus.
 *
 * A guard passes here only if it objects to all of its broken specimens and
 * stays quiet on all of its controls. Both halves fail the suite, because a
 * guard that fires on everything is as useless as one that fires on nothing.
 */
import { describe, expect, it } from 'vitest';

import { authorshipGuard } from '../src/kernel/guards/authorship.ts';
import { reviewPlan } from '../src/kernel/guards/convergence.ts';
import { reviewTurns } from '../src/kernel/guards/sycophancy.ts';
import { shouldClassify } from '../src/kernel/guards/vagueness.ts';
import type { GuardDecision } from '../src/types.ts';
import { AUTHORSHIP_SPECIMENS } from './specimens/authorship.ts';
import { CONVERGENCE_SPECIMENS } from './specimens/convergence.ts';
import { SYCOPHANCY_SPECIMENS } from './specimens/sycophancy.ts';
import { VAGUENESS_SPECIMENS } from './specimens/vagueness.ts';
import type { Verdict } from './specimens/types.ts';

/**
 * Collapse a decision to the corpus vocabulary. An objection is an objection
 * whether the guard refuses the call or annotates the screen with a blocking
 * note; the difference is how it is delivered, not whether it was raised.
 */
function verdictOf(decision: GuardDecision): Verdict {
  if (decision.kind === 'deny') return 'deny';
  if (decision.kind === 'modify') return 'annotate';
  if (decision.kind === 'annotate') {
    return decision.notes.some((n) => n.severity === 'blocking') ? 'deny' : 'annotate';
  }
  return 'pass';
}

function messageOf(decision: GuardDecision): string {
  if (decision.kind === 'deny') return decision.reason;
  if (decision.kind === 'annotate') return decision.notes.map((n) => n.message).join(' ');
  if (decision.kind === 'modify') return decision.note;
  return '';
}

describe('authorship guard', () => {
  for (const specimen of AUTHORSHIP_SPECIMENS) {
    it(specimen.name, () => {
      const decision = authorshipGuard.decide?.(specimen.input, {} as never) ?? { kind: 'pass' };
      expect(verdictOf(decision)).toBe(specimen.expect);
      if (specimen.reasonIncludes) {
        expect(messageOf(decision).toLowerCase()).toContain(specimen.reasonIncludes.toLowerCase());
      }
    });
  }
});

describe('convergence guard', () => {
  for (const specimen of CONVERGENCE_SPECIMENS) {
    it(specimen.name, () => {
      const decision = reviewPlan(specimen.input);
      expect(verdictOf(decision)).toBe(specimen.expect);
      if (specimen.reasonIncludes) {
        expect(messageOf(decision).toLowerCase()).toContain(specimen.reasonIncludes.toLowerCase());
      }
    });
  }
});

describe('sycophancy guard', () => {
  for (const specimen of SYCOPHANCY_SPECIMENS) {
    it(specimen.name, () => {
      const verdict = reviewTurns(specimen.input);
      const got = verdict.kind === 'block' ? 'block' : 'pass';
      expect(got).toBe(specimen.expect);
    });
  }

  it('records a near miss rather than blocking when a tool ran', () => {
    const verdict = reviewTurns([
      { role: 'user', text: 'are you sure?' },
      { role: 'assistant', text: 'checking', usedTool: true },
      { role: 'assistant', text: "You're absolutely right." },
    ]);
    expect(verdict.kind).toBe('near-miss');
  });
});

describe('vagueness prefilter', () => {
  for (const specimen of VAGUENESS_SPECIMENS) {
    it(specimen.name, () => {
      const got = shouldClassify(specimen.input) ? 'classify' : 'skip';
      expect(got).toBe(specimen.expect);
    });
  }
});
