/**
 * Standing order 16, applied to a `reply` ProposedAction: pushback recorded, a tool ran
 * or not, and the reply text itself. Reuses `hasCapitulation`/`hasEvidence` from the
 * kernel guard rather than re-deriving the pattern lists.
 */
import { hasCapitulation, hasEvidence, hasPushback } from '../../kernel/guards/sycophancy.ts';
import { deny, allow } from './types.ts';
import type { ProposedAction, RuleVerdict } from './types.ts';

const RULE_NAME = 'sycophancy';

export const sycophancyRule = {
  name: RULE_NAME,

  evaluate(action: ProposedAction): RuleVerdict {
    if (action.kind !== 'reply') return allow();
    const pushback = action.priorPushback;
    if (!pushback || !hasPushback(pushback)) return allow();
    if (!hasCapitulation(action.text)) return allow();
    if (action.hadToolCallSince) return allow();
    if (hasEvidence(pushback)) return allow();
    return deny(
      RULE_NAME,
      'Reversal under pressure with no tool call and no fact in between. Standing order ' +
        '16: a position changes on evidence, never on pressure. Check it, or hold the ' +
        'position and name the evidence behind it.',
    );
  },
};
