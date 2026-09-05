/**
 * Standing order 13, applied to Council's proposed actions instead of an SDK tool call.
 * Reuses the kernel guard's own detection (`findAttribution`, `publishKind`,
 * `isExemptPath`) rather than re-deriving the pattern list a second time -- a pattern
 * added there for a real incident stays a pattern here too.
 */
import { findAttribution, isExemptPath } from '../../kernel/guards/authorship.ts';
import { deny, allow } from './types.ts';
import type { ProposedAction, RuleVerdict } from './types.ts';

const RULE_NAME = 'authorship';

function textOf(action: ProposedAction): { text: string; where: string } | null {
  switch (action.kind) {
    case 'bash':
      return { text: action.command, where: 'shell command' };
    case 'commit':
      return { text: action.message, where: 'commit message' };
    case 'pr':
      return { text: `${action.title ?? ''}\n${action.body ?? ''}`, where: 'PR title/body' };
    case 'reply':
      return { text: action.text, where: 'reply' };
    case 'edit':
      if (isExemptPath(action.path)) return null;
      return { text: action.text, where: action.path };
    default:
      return null;
  }
}

export const authorshipRule = {
  name: RULE_NAME,

  evaluate(action: ProposedAction): RuleVerdict {
    const found = textOf(action);
    if (!found) return allow();
    const hit = findAttribution(found.text);
    if (!hit) return allow();
    return deny(
      RULE_NAME,
      `Machine authorship claim found in ${found.where}: ${hit.label}. Standing order 13: ` +
        'Aaron is the sole author of everything that ships. Rewrite in his voice.',
    );
  },
};
