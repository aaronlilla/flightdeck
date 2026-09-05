/**
 * Standing order 17, applied to a `reply` ProposedAction that proposes further work (a
 * fix-round instruction, a handoff note): the same stage-one filter the kernel guard
 * already proves, reused rather than re-derived. `shouldClassify` returning true means
 * the text is a work order with no anchor pinning down what "better" means.
 */
import { shouldClassify } from '../../kernel/guards/vagueness.ts';
import { deny, allow } from './types.ts';
import type { ProposedAction, RuleVerdict } from './types.ts';

const RULE_NAME = 'vagueness';

export const vaguenessRule = {
  name: RULE_NAME,

  evaluate(action: ProposedAction): RuleVerdict {
    if (action.kind !== 'reply') return allow();
    if (!shouldClassify(action.text)) return allow();
    return deny(
      RULE_NAME,
      'This work order names a quality goal with no anchor (a file, a line, an error, a ' +
        'stack trace) pinning down what it means. Standing order 17: an underspecified ' +
        'request gets questions, never a guess.',
    );
  },
};
