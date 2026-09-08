/**
 * Fills out an ask with too few options before it ever reaches the inbox (W1).
 *
 * A worker's `forge_ask` can name zero, one, or two options; a person reading `NeedsYou`
 * needs at least four and a recommendation, or there is nothing to click. When the worker
 * supplied fewer than `MIN_OPTIONS`, one bounded reasoner call drafts the rest; on any
 * failure the ask still raises with whatever the worker gave it and a null recommendation
 * rather than blocking the ask entirely.
 */
import type { Journal } from '../journal.js';
import type { Reasoner } from '../contracts.js';

export const FALLBACK_OPTION = 'Something else, I will type it';
const MIN_OPTIONS = 4;

export interface AskOptionsInput {
  run: string;
  goal?: string;
  question: string;
  options?: string[];
  recommended?: number;
  briefTitle?: string;
  recentJournalLines?: string[];
}

export interface AskOptionsResult {
  options: string[];
  recommended: number | null;
  source: 'worker' | 'drafted';
}

export interface CompleteAskOptionsDeps {
  reasoner: Reasoner;
  journal: Pick<Journal, 'append'>;
}

function nonEmpty(options: string[] | undefined): string[] {
  return (options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
}

function withFallback(options: string[]): string[] {
  return options.includes(FALLBACK_OPTION) ? options : [...options, FALLBACK_OPTION];
}

function journalWorker(
  deps: CompleteAskOptionsDeps, input: AskOptionsInput, options: string[],
  recommended: number | null, error?: string,
): AskOptionsResult {
  deps.journal.append({
    event: 'forge.ask.options', run: input.run, actor: 'worker', source: 'worker',
    options, recommended, ...(error ? { error } : {}),
  });
  return { options, recommended, source: 'worker' };
}

function draftPrompt(input: AskOptionsInput, workerOptions: string[]): string {
  return [
    `Question: ${input.question}`,
    input.briefTitle ? `Brief: ${input.briefTitle}` : '',
    workerOptions.length ? `Options already offered: ${workerOptions.join(' | ')}` : '',
    (input.recentJournalLines ?? []).length
      ? `Recent activity:\n${(input.recentJournalLines ?? []).join('\n')}`
      : '',
    'Reply with {"text": "<json>"} where <json> parses to',
    '{"options": string[], "recommended": number}: 4 to 6 distinct, non-empty options',
    'covering this question, and recommended as the zero-based index of the best one.',
  ].filter(Boolean).join('\n\n');
}

export async function completeAskOptions(
  input: AskOptionsInput, deps: CompleteAskOptionsDeps,
): Promise<AskOptionsResult> {
  const workerOptions = nonEmpty(input.options);
  if (workerOptions.length >= MIN_OPTIONS) {
    return journalWorker(deps, input, withFallback(workerOptions), input.recommended ?? null);
  }

  try {
    const reply = await deps.reasoner.call({
      className: 'triage', prompt: draftPrompt(input, workerOptions), run: input.run,
    });
    const parsed = JSON.parse(reply.text) as { options?: unknown; recommended?: unknown };
    const drafted = Array.isArray(parsed.options)
      ? [...new Set(parsed.options.filter(
        (o): o is string => typeof o === 'string' && o.trim().length > 0,
      ).map((o) => o.trim()))]
      : [];
    const recommended = typeof parsed.recommended === 'number' ? parsed.recommended : null;
    if (drafted.length < MIN_OPTIONS || recommended === null
      || recommended < 0 || recommended >= drafted.length) {
      throw new Error('reasoner reply did not carry 4+ distinct options with a valid recommendation');
    }
    const options = withFallback(drafted);
    deps.journal.append({
      event: 'forge.ask.options', run: input.run, actor: 'reasoner', source: 'drafted',
      options, recommended,
    });
    return { options, recommended, source: 'drafted' };
  } catch (error) {
    return journalWorker(
      deps, input, withFallback(workerOptions), null,
      error instanceof Error ? error.message : String(error),
    );
  }
}
