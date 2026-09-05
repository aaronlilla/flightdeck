/**
 * New rule; no corpus existed anywhere in flightdeck before this stream. Derived from
 * the `humanizer` skill's own rule list (`doctrine/skills/humanizer/SKILL.md`) rather
 * than the ported guards, because that skill was never wired into flightdeck's four
 * `PreToolUse` guards (`2026-09-04-forge-council.md` decision 2).
 *
 * Scoped to the patterns a regex can catch without judgment: em dashes (rule 14, named
 * a hard constraint rather than a preference), overused AI vocabulary (rule 7), negative
 * parallelism (rule 9), and boldface overuse (rule 15). The skill's other rules
 * (inflated significance, elegant variation, false ranges, rule-of-three overuse, ...)
 * need a reader's judgment a mechanical check cannot supply reliably; the goal brief's
 * Status section names that gap rather than papering over it with a noisy detector.
 */
import { deny, allow } from './types.ts';
import type { ProposedAction, RuleVerdict } from './types.ts';

const RULE_NAME = 'humanizer';

const EM_DASH = /[—–]| -- /;

const AI_VOCABULARY =
  /\b(actually|additionally|align with|crucial|delve|emphasizing|enduring|enhance|fostering|garner|highlight|interplay|intricate|intricacies|pivotal|showcase|tapestry|testament|underscore|underscores|valuable|vibrant)\b/i;

const NEGATIVE_PARALLELISM = /\bit'?s not (just|merely) [^,.;]+,\s*it'?s\b/i;

function boldCount(text: string): number {
  const matches = text.match(/\*\*[^*\n]+\*\*/g);
  return matches ? matches.length : 0;
}

function textOf(action: ProposedAction): string | null {
  switch (action.kind) {
    case 'commit':
      return action.message;
    case 'pr':
      return `${action.title ?? ''}\n${action.body ?? ''}`;
    case 'reply':
      return action.text;
    case 'edit':
      return action.text;
    default:
      return null;
  }
}

export const humanizerRule = {
  name: RULE_NAME,

  evaluate(action: ProposedAction): RuleVerdict {
    const text = textOf(action);
    if (!text) return allow();

    if (EM_DASH.test(text)) {
      return deny(RULE_NAME, 'Carries an em dash (or a `--` standing in for one), one of the most reliable AI-writing tells. Rewrite as two sentences, a comma, or parentheses.');
    }
    if (AI_VOCABULARY.test(text)) {
      const hit = text.match(AI_VOCABULARY)?.[0] ?? '';
      return deny(RULE_NAME, `Uses overused AI vocabulary ("${hit}"). Say the plain thing instead.`);
    }
    if (NEGATIVE_PARALLELISM.test(text)) {
      return deny(RULE_NAME, 'Negative parallelism ("it\'s not just X, it\'s Y"). State the point directly instead.');
    }
    if (boldCount(text) >= 3) {
      return deny(RULE_NAME, 'Boldface overuse: three or more bolded terms in one passage reads as mechanical emphasis.');
    }
    return allow();
  },
};
