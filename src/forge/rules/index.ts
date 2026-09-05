/**
 * The rules module Council's gate calls on a commit message, a PR title/body, and a
 * diff-derived action; the worker's PreToolUse hook calls the same library on Bash and
 * Edit inputs once P4.7's follow-up commit wires it in (`sdkengine.ts` is B.3's file
 * until then). `evaluateAction` runs every rule and returns the first denial, because a
 * gate needs one verdict, not five independent opinions to reconcile itself.
 */
import { gitflowRule } from './gitflow.ts';
import { authorshipRule } from './authorship.ts';
import { humanizerRule } from './humanizer.ts';
import { sycophancyRule } from './sycophancy.ts';
import { vaguenessRule } from './vagueness.ts';
import type { ProposedAction, Rule, RuleVerdict } from './types.ts';

export type { ProposedAction, Rule, RuleVerdict } from './types.ts';
export { allow, deny } from './types.ts';
export { gitflowRule } from './gitflow.ts';
export { authorshipRule } from './authorship.ts';
export { humanizerRule } from './humanizer.ts';
export { sycophancyRule } from './sycophancy.ts';
export { vaguenessRule } from './vagueness.ts';

/**
 * `2026-09-04-forge-roadmap.md:139`'s list: gitflow, authorship, humanizer, sycophancy,
 * vagueness. Convergence is out of scope (decision 3: the roadmap retires the hook, not
 * the specimen, and flightdeck's kernel guard keeps its own corpus untouched).
 */
export const RULES: Rule[] = [gitflowRule, authorshipRule, humanizerRule, sycophancyRule, vaguenessRule];

export function evaluateAction(action: ProposedAction): RuleVerdict {
  for (const rule of RULES) {
    const verdict = rule.evaluate(action);
    if (!verdict.allow) return verdict;
  }
  return { allow: true };
}
