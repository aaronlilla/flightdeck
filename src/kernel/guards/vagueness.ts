/**
 * Standing order 17: an underspecified request gets questions, never a guess.
 *
 * Two stages. Stage one is the cheap filter below, which decides whether a
 * prompt is even the kind of thing that can be underspecified. Stage two asks a
 * model to name the gaps, costs a call, and is injected rather than wired in,
 * so this module stays pure and testable and the caller decides what to spend.
 *
 * Nearly all the value is in stage one. Every prompt it wrongly forwards
 * becomes an interview Aaron did not ask for, and a gate that interrupts
 * correct work is a gate that gets switched off inside a week. So the filter is
 * written to let things through: whatever nobody declared stays invisible, and
 * the failure it prefers is silence.
 */
import type { Guard, GuardDecision, KernelEvent } from '../../types.ts';

const WRAPPERS =
  /<(system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi;

/** Direction words. A prompt this short is only vague if it asks for a quality. */
const QUALITY_WORDS =
  /\b(better|nicer|cleaner|neater|tidier|simpler|smoother|faster|quicker|snappier|prettier|stronger|safer|improve[sd]?|polish|optimi[sz]e[sd]?|clean ?up|tidy|moderni[sz]e|robust|solid|properly|consistent|reliable|maintainable)\b/i;

/** Anything concrete enough to answer "which one" on its own. */
const ANCHORS: RegExp[] = [
  /```/,
  /[\w./\\-]+\.[a-zA-Z0-9]{1,6}\b/,
  /[/\\][\w.-]+[/\\]/,
  /:\d+\b/,
  /https?:\/\//,
  /\b[A-Z][A-Za-z0-9]*Error\b|\bexit code\b|\bstack ?trace\b|\btraceback\b/i,
  /`[^`]+`/,
];

const WH_OPENERS = /^(what|why|how|when|where|who|which|explain|tell me|show me|remind)\b/i;
const AUX_OPENERS = /^(is|are|was|were|does|did|can|could|should|would|will|has|have)\b/i;
const DO_QUESTION = /^do\s+(we|you|i|they|it|this|that)\b/i;
const CONTINUATION =
  /^(y|yes|no|ok|okay|sure|go ahead|go|continue|carry on|keep going|next|do it|proceed|thanks|ty|nice|good|perfect|great|stop|wait|undo|revert|again|same|also|and|plus|then)\b/i;

const BUILD_VERBS =
  /\b(add|build|make|create|implement|write|set ?up|wire|integrate|support|handle|refactor|rewrite|redesign|migrate|port|convert|extend|improve|optimi[sz]e|clean ?up|fix|change|update|replace|remove|delete|rename|move|split|merge|generate|automate|hook ?up|expose|enable|disable)\b/i;

/**
 * Research is a work order too, and it fails differently: the wrong frame makes
 * the answer discard correct options as impossible and say nothing about having
 * done so, so the mistake never appears in the output.
 */
const RESEARCH_VERBS =
  /\b(research|investigate|analy[sz]e|analysis|audit|evaluate|assess|compare|survey|benchmark|scout|look into|dig into|find out|figure out|work out|scope out)\b/i;

const SHORT_PROMPT = 40;
const HATCH = '~~';

export function clean(text: string): string {
  return text.replace(WRAPPERS, ' ').trim();
}

/**
 * Stage one. Returns null when the prompt should go to the classifier, or a
 * sentence explaining why it was let through untouched.
 *
 * Order matters and is the same order the Python gate used. Each check is
 * cheaper and more certain than the one after it.
 */
export function prefilter(rawPrompt: string): string | null {
  const prompt = clean(rawPrompt);
  if (!prompt) return 'nothing but wrapper blocks, which are not Aaron speaking';
  if (prompt.startsWith(HATCH)) return 'escape hatch';
  if (prompt.startsWith('/') || prompt.startsWith('!')) return 'a command, not a request';
  if (CONTINUATION.test(prompt)) return 'a continuation of the current thread';
  if (prompt.endsWith('?')) return 'a question, not a work order';
  if (WH_OPENERS.test(prompt) || AUX_OPENERS.test(prompt)) return 'a question, not a work order';
  if (DO_QUESTION.test(prompt)) return 'a question, not a work order';
  if (!BUILD_VERBS.test(prompt) && !RESEARCH_VERBS.test(prompt)) {
    return 'no build or research verb, so there is nothing to be vague about';
  }
  const anchor = ANCHORS.find((re) => re.test(prompt));
  if (anchor) return 'carries a concrete anchor';
  if (prompt.length < SHORT_PROMPT && !QUALITY_WORDS.test(prompt)) {
    return 'short, and names a specific change rather than a direction';
  }
  return null;
}

export const shouldClassify = (prompt: string): boolean => prefilter(prompt) === null;

/** Stage two, supplied by the caller because it costs a model call. */
export type Classifier = (prompt: string) => Promise<string[]>;

export const INTERVIEW_INSTRUCTION =
  'UNDERSPECIFIED REQUEST. Ask before building. Use AskUserQuestion before any other tool ' +
  'call: up to four questions, two to four concrete options each, your recommendation first. ' +
  'Do not invent the missing specifics and then treat your own invention as a requirement. ' +
  `Prefix a prompt with ${HATCH} to skip this for one turn.`;

export function createVaguenessGuard(
  classify: Classifier | null,
  onNote: (note: string) => void,
): Guard {
  return {
    name: 'vagueness',
    observe(event: KernelEvent): void {
      if (event.type !== 'prompt') return;
      if (!shouldClassify(event.text)) return;
      if (!classify) {
        // No classifier wired, so the prompt is forwarded untouched. Saying so
        // beats implying a check happened.
        return;
      }
      void classify(clean(event.text))
        .then((gaps) => {
          if (gaps.length === 0) return;
          onNote(`${INTERVIEW_INSTRUCTION}\n\nGaps: ${gaps.join('; ')}`);
        })
        .catch(() => {
          // Fails open on purpose. A classifier that errored has not found a
          // gap, and refusing the turn over its failure would train Aaron to
          // switch the gate off.
        });
    },
    decide(): GuardDecision {
      return { kind: 'pass' };
    },
  };
}
