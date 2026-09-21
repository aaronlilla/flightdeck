/**
 * The gauntlet loop: a builder drafts, a separate critic judges it against real comments
 * by other people, the builder rewrites against the critic's one named gap, and the loop
 * exits when the critic picks ours.
 *
 * Why a loop rather than the single rewording `runFeedActivity` already had: measured on
 * 2026-09-18 over 53 real parked questions, a harsh critic rejected 31 of the first
 * drafts, and the rejections were not stylistic. They were claims the code did not
 * support, a code comment credited to the wrong author, an instruction to reproduce a
 * state the app clamps so it cannot happen, and replies answering a question the bottom
 * of the same thread had already settled. One rewording does not find those; a critic
 * with fresh context and the actual thread does.
 *
 * Three rules this file exists to enforce, each of which was a real failure first:
 *
 *  - The critic is a SEPARATE call with its own prompt. A builder asked to check its own
 *    work approves it, because it knows how hard it tried.
 *  - The verdict is binary, `ours` or `theirs`. A score out of ten drifts upward every
 *    round until everything passes.
 *  - Exit is winning, never a round count. The cap exists so a loop cannot run forever,
 *    and reaching it is a deferral to a person, never a post.
 *
 * Nothing here touches the network or the filesystem: the reasoner, the bar and the gate
 * are all injected, the same seams `jiraFeed.ts` already defines.
 */

/** A comment somebody else wrote on the same board. The bar is always real text, never a
 *  description of a voice: a critic given "write like a developer" invents a comparison
 *  and approves anything. */
export interface BarComment {
  ticket: string;
  author: string;
  body: string;
}

export interface GauntletRound {
  round: number;
  draft: string;
  /** `ours` means the critic picked our draft over the bar comments. */
  verdict: 'ours' | 'theirs';
  /** The critic's own claim that every statement in the draft is supported by the thread
   *  it was given. A false here fails the round even when the voice won. */
  supported: boolean;
  /** The single biggest remaining problem, or empty when the critic found none. */
  gap: string;
  /** Why the round ended where it did, for the journal and the inbox question. */
  note: string;
}

export type GauntletOutcome =
  | { won: true; reply: string; rounds: GauntletRound[] }
  | { won: false; reason: string; bestDraft: string; rounds: GauntletRound[] };

export interface GauntletDeps {
  /** Writes or rewrites the reply. `critique` is absent on the first round. */
  build(input: { round: number; previous?: string; critique?: GauntletRound }): Promise<string>;
  /** Judges the draft against the bar. Separate call, fresh context, binary verdict. */
  critique(input: { round: number; draft: string }): Promise<GauntletRound | null>;
  /**
   * The mechanical gates (`replyRefusal`: length, voice, banned words, humanizer). Runs
   * BEFORE the critic, because a draft that can never post is not worth judging, and its
   * refusal is a better instruction to the builder than a critic's prose.
   */
  gate(reply: string): string | null;
  /** Hard stop so a loop cannot run forever. Reaching it defers, never posts. */
  maxRounds: number;
}

/**
 * Runs the loop. Returns `won` only when a draft passed the gate AND the critic picked it
 * over the bar AND the critic found its claims supported. Anything else is a deferral
 * carrying the best draft, so a person sees the work rather than an empty inbox row.
 */
export async function runGauntlet(deps: GauntletDeps): Promise<GauntletOutcome> {
  const rounds: GauntletRound[] = [];
  let previous: string | undefined;
  let lastCritique: GauntletRound | undefined;
  let bestDraft = '';

  for (let round = 1; round <= deps.maxRounds; round += 1) {
    let draft: string;
    try {
      draft = (await deps.build({ round, ...(previous ? { previous } : {}), ...(lastCritique ? { critique: lastCritique } : {}) })).trim();
    } catch (error) {
      return { won: false, reason: `the builder failed on round ${round}: ${message(error)}`, bestDraft, rounds };
    }
    if (draft.length === 0) {
      return { won: false, reason: `the builder returned nothing on round ${round}`, bestDraft, rounds };
    }
    bestDraft = draft;
    previous = draft;

    // The gate first: a refusal is a precise instruction ("161 words, over the 160-word
    // ceiling") and costs nothing, where a critic call on an unpostable draft is a wasted
    // round. The refusal is fed back as the round's gap so the builder fixes exactly it.
    const refusal = deps.gate(draft);
    if (refusal) {
      const gateRound: GauntletRound = {
        round, draft, verdict: 'theirs', supported: false, gap: refusal,
        note: 'refused by the comment check before the critic saw it',
      };
      rounds.push(gateRound);
      lastCritique = gateRound;
      continue;
    }

    let verdict: GauntletRound | null;
    try {
      verdict = await deps.critique({ round, draft });
    } catch (error) {
      return { won: false, reason: `the critic failed on round ${round}: ${message(error)}`, bestDraft, rounds };
    }
    if (!verdict) {
      return { won: false, reason: `the critic answered in a shape the loop cannot read on round ${round}`, bestDraft, rounds };
    }
    rounds.push(verdict);
    lastCritique = verdict;

    if (verdict.verdict === 'ours' && verdict.supported) {
      return { won: true, reply: draft, rounds };
    }
  }

  return {
    won: false,
    reason: `the critic did not pick ours within ${deps.maxRounds} rounds; last gap: ${lastCritique?.gap || 'none named'}`,
    bestDraft,
    rounds,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------
// Prompts

/** Up to this many bar comments go into a critic prompt. Enough to show a range of
 *  lengths and registers, few enough that the thread stays the larger half of the call. */
const BAR_SAMPLE = 8;

export function barSample(bar: readonly BarComment[], limit: number = BAR_SAMPLE): BarComment[] {
  // Longest first: a one-line "closing this out" teaches a critic nothing about whether
  // our three-sentence reply sounds human.
  return [...bar].sort((a, b) => b.body.length - a.body.length).slice(0, limit);
}

/**
 * The critic's prompt. Deliberately withholds which text is ours: the labels are A and B
 * with ours in a stated position only to the parser, never described as "the draft we
 * wrote". A critic told which side is the home team picks the home team.
 */
export function critiquePrompt(input: {
  draft: string;
  thread: string;
  bar: readonly BarComment[];
  question: string;
}): string {
  const samples = barSample(input.bar)
    .map((c, i) => `--- comment ${i + 1}, on ${c.ticket} ---\n${c.body}`)
    .join('\n\n');
  return [
    'You are a harsh critic. Praise is worthless here. Your job is to find what is wrong.',
    '',
    'Here is a question somebody asked on a ticket, and the thread it sits in:',
    input.question,
    '',
    input.thread,
    '',
    'Here are real comments other people wrote on this same board:',
    '',
    samples,
    '',
    'Here is a candidate answer to the question:',
    '',
    input.draft,
    '',
    'Answer three things.',
    'First, read the candidate next to those real comments with the names stripped from',
    'your mind, and say which reads like a teammate who actually read the ticket. Answer',
    'with one word, ours for the candidate or theirs for the real comments. Do not score',
    'anything out of ten.',
    'Second, say whether every claim the candidate makes is supported by the thread above.',
    'A claim about code the thread does not mention, a fact credited to the wrong person,',
    'an instruction to reproduce something the thread says cannot happen, or an answer to',
    'a question a later comment in the thread already settled, all mean no.',
    'Third, name the single biggest remaining problem in one sentence.',
    '',
    'Answer with exactly these four lines and nothing else:',
    'VERDICT: ours | theirs',
    'SUPPORTED: yes | no',
    'GAP: <one sentence, or the word none>',
    'WHY: <one sentence>',
  ].join('\n');
}

/** The builder's rewrite instruction. First round has no critique and returns empty. */
export function repairPrompt(critique: GauntletRound): string {
  return [
    '',
    'A critic read your last answer and turned it down.',
    `What it said: ${critique.gap || critique.note}`,
    critique.verdict === 'theirs'
      ? 'It also said the real comments on the board read more like a person than yours did.'
      : '',
    critique.supported ? '' : 'It could not find support in the thread for at least one claim you made.',
    'Write it again. Fix that, keep what was right, and do not pad it to look thorough.',
  ].filter(Boolean).join('\n');
}

/** Reads the critic's four lines. Also accepts the same fields as a JSON object, which is
 *  what a model that ignored the line format sends. Unreadable is `null`, and the caller
 *  treats that as a deferral rather than a pass. */
export function parseCritique(text: string, round: number, draft: string): GauntletRound | null {
  const trimmed = text.trim();
  const fromJson = tryJson(trimmed);
  const source = fromJson ?? trimmed;

  const verdictRaw = field(source, 'VERDICT', fromJson?.verdict);
  const supportedRaw = field(source, 'SUPPORTED', fromJson?.supported);
  if (!verdictRaw) return null;

  const verdict = /\bours\b/i.test(verdictRaw) ? 'ours' : /\btheirs\b/i.test(verdictRaw) ? 'theirs' : null;
  if (!verdict) return null;

  // An unreadable or absent SUPPORTED is false, never true: the loop must not post
  // because a critic forgot a line.
  const supported = supportedRaw ? /^\s*(yes|true)\b/i.test(supportedRaw) : false;
  const gapRaw = field(source, 'GAP', fromJson?.gap) ?? '';
  const gap = /^none\b/i.test(gapRaw.trim()) ? '' : gapRaw.trim();
  const note = (field(source, 'WHY', fromJson?.why) ?? '').trim();

  return { round, draft, verdict, supported, gap, note };
}

interface CritiqueJson { verdict?: unknown; supported?: unknown; gap?: unknown; why?: unknown }

function tryJson(text: string): CritiqueJson | null {
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as CritiqueJson : null;
  } catch {
    return null;
  }
}

function field(source: string | CritiqueJson, label: string, jsonValue: unknown): string | null {
  if (typeof source !== 'string') {
    if (jsonValue === undefined || jsonValue === null) return null;
    return typeof jsonValue === 'boolean' ? (jsonValue ? 'yes' : 'no') : String(jsonValue);
  }
  const match = new RegExp(`^\\s*${label}:\\s*(.*)$`, 'im').exec(source);
  return match?.[1] ?? null;
}
