/**
 * Standing order 16: a position changes on evidence, never on pressure.
 *
 * The guard watches for one shape and only that shape: Aaron pushes back, and
 * the reply folds without a fact or a tool call in between. All three have to
 * hold. Two of three is a near miss and stays quiet, because a guard that fired
 * whenever the agent agreed would make agreement impossible rather than earned,
 * and agreement is often correct.
 */
import type { Guard, GuardDecision, KernelEvent, SessionState } from '../../types.ts';

/** Blocks the harness injects. None of this is Aaron speaking. */
const WRAPPERS =
  /<(system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi;

const PUSHBACK: RegExp[] = [
  /\bare you sure\b/i,
  /\byou'?re wrong\b/i,
  /\b(that'?s|this is|that is) (wrong|incorrect|not right|false|nonsense)\b/i,
  /\bi (don'?t|do not) (think|believe|agree)\b/i,
  /\bi disagree\b/i,
  /\bno,\s*(it|that|this|you|the)\b/i,
  /\bthat (does ?n[o']t|doesn'?t) (seem|sound|look) right\b/i,
  /\bis that (really )?(true|right|correct)\b/i,
  /\bwhy (would|did) you\b/i,
  /\bthat'?s not (what|how)\b/i,
  /\byou (missed|got it wrong|misread)\b/i,
  /\breally\?/i,
];

/** A fact in the pushback makes the reversal correct rather than servile. */
const EVIDENCE: RegExp[] = [
  /`[^`\n]+`/,
  /\b[\w./\\-]+\.(?:py|ts|tsx|js|jsx|md|json|ps1|sh|cs|java|kt|go|rs|rb|yml|yaml|toml|sql)\b/,
  /:\d+\b/,
  /\bhttps?:\/\//,
  /```/,
  /\b\d+(?:\.\d+)?\s*(?:ms|s|kb|mb|gb|%|px|x)\b/i,
  /\bi (just )?(ran|tried|tested|checked|looked|opened|profiled)\b/i,
  /\b(the )?(output|error|log|stack ?trace|traceback|docs?|spec) (say|says|said|was|is|shows)\b/i,
  /\bit (returned|printed|threw|crashed|failed with)\b/i,
  /\bexit code\b/i,
];

const CAPITULATION: RegExp[] = [
  /\byou'?re (absolutely |completely |totally )?right\b/i,
  /\byou are (absolutely |completely |totally )?right\b/i,
  /\byou'?re correct\b/i,
  /\bgood catch\b/i,
  /\bmy (mistake|apologies|bad|error)\b/i,
  /\bi apolog(ise|ize)\b/i,
  /\bi was wrong\b/i,
  /\bfair (enough|point)\b/i,
  /\bof course,? you\b/i,
  /\bgreat (point|question|catch)\b/i,
];

/** Signals worth naming to the model before it answers, which never block. */
const LEADING: RegExp[] = [
  /\bthe (problem|issue|bug|cause|reason) is\b/i,
  /\bit'?s (because|caused by|due to)\b/i,
  /\bobviously\b/i,
  /\bsurely\b/i,
];

const APPROVAL: RegExp[] = [
  /\blooks good\b/i,
  /\blgtm\b/i,
  /\bperfect\b/i,
  /\bnice work\b/i,
  /\bexcellent\b/i,
  /\blove it\b/i,
];

export function strip(text: string): string {
  return text.replace(WRAPPERS, ' ').trim();
}

const anyMatch = (patterns: RegExp[], text: string) => patterns.some((re) => re.test(text));

export const hasPushback = (text: string) => anyMatch(PUSHBACK, text);
export const hasEvidence = (text: string) => anyMatch(EVIDENCE, text);
export const hasCapitulation = (text: string) => anyMatch(CAPITULATION, text);

/** A turn as this guard needs to see it. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  usedTool?: boolean;
  isSidechain?: boolean;
  isMeta?: boolean;
}

export type SycophancyVerdict =
  | { kind: 'pass' }
  | { kind: 'near-miss'; why: string }
  | { kind: 'block'; pushback: string; capitulation: string };

/**
 * Read the tail of a conversation and decide whether the last reply was a fold.
 *
 * Kept pure and separate from the Guard object so the corpus can drive it
 * directly with a list of turns.
 */
export function reviewTurns(turns: Turn[]): SycophancyVerdict {
  let lastUserIndex = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || turn.role !== 'user') continue;
    // Injected text and subagent chatter are not Aaron applying pressure.
    if (turn.isMeta || turn.isSidechain) continue;
    lastUserIndex = i;
    break;
  }
  if (lastUserIndex === -1) return { kind: 'pass' };

  const pushbackText = strip(turns[lastUserIndex]?.text ?? '');
  if (!hasPushback(pushbackText)) return { kind: 'pass' };

  const since = turns.slice(lastUserIndex + 1).filter((t) => t.role === 'assistant' && !t.isSidechain);
  const toolRan = since.some((t) => t.usedTool);
  const folded = since.find((t) => hasCapitulation(strip(t.text)));

  if (!folded) return { kind: 'pass' };
  if (toolRan) return { kind: 'near-miss', why: 'a tool ran, so the turn gathered evidence' };
  if (hasEvidence(pushbackText)) {
    return { kind: 'near-miss', why: 'the pushback carried a fact, so updating on it is correct' };
  }

  return {
    kind: 'block',
    pushback: pushbackText.slice(0, 200),
    capitulation: strip(folded.text).slice(0, 200),
  };
}

/** Pressure in an incoming prompt, named for the model before it answers. */
export function readPrompt(text: string): string | null {
  const clean = strip(text);
  if (anyMatch(PUSHBACK, clean)) {
    return (
      'PRESSURE SIGNAL. That is pushback, not a fact. Standing order 16: a position changes on ' +
      'evidence, never on pressure. Check it if it is checkable. Otherwise state the ' +
      "disagreement once with the evidence behind it and close with: Say `argue it` and I'll " +
      'make the full case.'
    );
  }
  if (anyMatch(LEADING, clean)) {
    return (
      'PRESSURE SIGNAL (leading premise). That is a premise, not a finding. Test it against at ' +
      'least one rival account before building on it.'
    );
  }
  if (anyMatch(APPROVAL, clean)) {
    return (
      'PRESSURE SIGNAL (approval). Approval is not verification. It does not close anything you ' +
      'have not personally checked.'
    );
  }
  return null;
}

export function createSycophancyGuard(
  history: () => Turn[],
  onNote: (note: string) => void,
): Guard {
  return {
    name: 'sycophancy',
    observe(event: KernelEvent, _state: SessionState): void {
      if (event.type === 'prompt') {
        const note = readPrompt(event.text);
        if (note) onNote(note);
        return;
      }
      if (event.type === 'turn-complete') {
        const verdict = reviewTurns(history());
        if (verdict.kind === 'block') {
          onNote(
            `REVERSAL UNDER PRESSURE. Aaron pushed back ("${verdict.pushback}") and the reply ` +
              `folded ("${verdict.capitulation}") with no tool call and no fact in between. ` +
              'Name the evidence, go and check, or hold the position.',
          );
        }
      }
    },
    decide(): GuardDecision {
      return { kind: 'pass' };
    },
  };
}
