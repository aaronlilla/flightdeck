/**
 * Pads a `forge_ask` call's options out to a real choice, before the ask ever reaches
 * the inbox (W1, 2026-09-08).
 *
 * A worker asking "dev or staging?" with two bare options gives a person nothing to
 * click but the two words the worker already typed in the question. `completeAskOptions`
 * runs one bounded `triage`-class reasoner call to draft the missing options and pick a
 * recommendation whenever fewer than four arrive, and always appends a final free-text
 * option so a person can answer something the drafted list missed. On any reasoner
 * failure the worker's own options ship as-is with `recommended: null` rather than
 * blocking the ask -- a question a person can still answer, just without a suggested
 * pick, beats a question that never reaches the inbox at all.
 */
import { z } from 'zod';

import type { Journal } from '../journal.js';
import type { Reasoner } from '../contracts.js';

export const FREE_TEXT_OPTION = 'Something else, I will type it';

/** Below this many options, `completeAskOptions` asks the reasoner to draft more.
 *  Four is the brief's own floor: three from the worker plus a recommendation with
 *  nothing else to weigh against reads as no choice at all. */
const MIN_OPTIONS = 4;

const DRAFT_REPLY_SCHEMA = z.object({
  options: z.array(z.string().min(1)).min(1),
  recommended: z.number().int().min(0),
});

export interface CompleteAskOptionsDeps {
  reasoner: Reasoner;
  journal: Pick<Journal, 'append'>;
  run: string;
  /** The run's brief title and its last few journal rows, handed to the reasoner as
   *  context for what the missing options should actually be. Optional: a caller with
   *  nothing to add still gets a bare question drafted from. */
  briefTitle?: string;
  recentJournalRows?: string[];
}

export interface CompletedAskOptions {
  options: string[];
  /** `null` when nobody has a usable recommendation (worker gave enough options with
   *  none of its own, or the reasoner failed) -- never `undefined`, so a caller can
   *  always tell "looked and found nothing" from "never looked". */
  recommended: number | null;
  optionSource: 'worker' | 'drafted';
}

function draftPrompt(question: string, deps: CompleteAskOptionsDeps): string {
  const lines = [
    'A worker paused mid-run to ask a person a question, with too few options for a',
    'real choice. Draft the missing options and pick the one you would recommend.',
    '',
    `Question: ${question}`,
  ];
  if (deps.briefTitle) lines.push(`Run brief: ${deps.briefTitle}`);
  if (deps.recentJournalRows?.length) {
    lines.push('Recent activity on this run:', ...deps.recentJournalRows.map((row) => `- ${row}`));
  }
  lines.push(
    '',
    'Reply with exactly one JSON object: {"text": "{\\"options\\": [\\"opt1\\", \\"opt2\\", ...],',
    '\\"recommended\\": 0}"} -- four to six distinct, non-empty options and an index into',
    'that list for the one you recommend.',
  );
  return lines.join('\n');
}

/**
 * `options` always ends with `FREE_TEXT_OPTION`, appended after every other decision is
 * made, so it is never itself the recommendation.
 */
export async function completeAskOptions(
  ask: { question: string; options?: string[] },
  deps: CompleteAskOptionsDeps,
): Promise<CompletedAskOptions> {
  if (ask.question.trim() === '') {
    throw new Error('forge_ask: the question cannot be empty');
  }

  const workerOptions = ask.options ?? [];

  if (workerOptions.length >= MIN_OPTIONS) {
    const result: CompletedAskOptions = {
      options: [...workerOptions, FREE_TEXT_OPTION],
      recommended: null,
      optionSource: 'worker',
    };
    deps.journal.append({
      event: 'forge.ask.options', run: deps.run, actor: 'runner',
      source: result.optionSource, options: result.options, recommended: result.recommended,
    });
    return result;
  }

  try {
    const reply = await deps.reasoner.call({
      className: 'triage', prompt: draftPrompt(ask.question, deps), run: deps.run,
    });
    const inner = JSON.parse(reply.text) as unknown;
    const parsed = DRAFT_REPLY_SCHEMA.parse(inner);
    if (parsed.recommended >= parsed.options.length) {
      throw new Error('the drafted recommendation index is out of range');
    }
    const draftedOptions = [...new Set([...workerOptions, ...parsed.options])];
    const recommendedText = parsed.options[parsed.recommended];
    const recommendedIndex = draftedOptions.indexOf(recommendedText as string);
    const result: CompletedAskOptions = {
      options: [...draftedOptions, FREE_TEXT_OPTION],
      recommended: recommendedIndex >= 0 ? recommendedIndex : null,
      optionSource: 'drafted',
    };
    deps.journal.append({
      event: 'forge.ask.options', run: deps.run, actor: 'runner',
      source: result.optionSource, options: result.options, recommended: result.recommended,
      model: 'triage',
    });
    return result;
  } catch (error) {
    const result: CompletedAskOptions = {
      options: [...workerOptions, FREE_TEXT_OPTION],
      recommended: null,
      optionSource: 'worker',
    };
    deps.journal.append({
      event: 'forge.ask.options', run: deps.run, actor: 'runner',
      source: result.optionSource, options: result.options, recommended: result.recommended,
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}
