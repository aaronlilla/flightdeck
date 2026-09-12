/**
 * Planning a ticket is an interview before it is a brief (spec
 * `doctrine/design/operator-experience.md` §3, roadmap R-76).
 *
 * `planner.ts` asks the model once and takes whatever brief comes back, so a ticket
 * missing a fact gets a brief that guesses at it. This module splits that into two
 * calls with people in between: `interview` asks for up to four typed questions, the
 * caller answers them (from the repository via `scout.ts`, from the operator, or from a
 * teammate over Slack), and `writeBrief` writes the brief with every answer in a
 * `## Decisions` section.
 *
 * There is exactly one `interview` call per item. A second round would let the model
 * keep finding new things to ask and hold the item forever; the cap and the single
 * round together are what bound it (G4).
 */
import type { Packet, Reasoner } from '../contracts.ts';
import type { PlannedBrief } from './planner.ts';

/** Four is the ceiling the spec sets. A fifth question is dropped, not deferred. */
export const MAX_QUESTIONS = 4;

/** Who can answer a question. `repo` goes to the scout and never reaches a person;
 *  `aaron` and `teammate` both raise an ask, and only a `teammate` one can be passed. */
export type AnswerableBy = 'repo' | 'aaron' | 'teammate';

export interface InterviewQuestion {
  text: string;
  options: string[];
  recommended: number | null;
  answerableBy: AnswerableBy;
  /** The teammate this question belongs to, once defaulted. Absent for `repo` and
   *  `aaron` questions. */
  who?: string;
  /** What the question is about, used only to default `who`. */
  topic?: string;
}

export interface InterviewResult {
  /** `backend` means the ticket belongs to the backend: no questions are raised and the
   *  planning hop sends the item to the existing backend handoff with `ask`. */
  route: 'frontend' | 'backend';
  questions: InterviewQuestion[];
  /** Present on the backend route: the exact sentence the handoff carries. */
  ask?: string;
}

export interface InterviewAnswer {
  question: string;
  answer: string;
  /** A person's name, or a plain phrase like `the repo` -- rendered verbatim into the
   *  brief's `## Decisions` section, so the brief says who decided each thing. */
  answeredBy: string;
}

export type JournalAppend = (row: { event: string; [key: string]: unknown }) => void;

/** A teammate question the model left unnamed. Backend questions go to the backend lead,
 *  product questions to the product owner; anything else stays unnamed and reads as an
 *  operator question the operator can pass by hand. */
const TOPIC_OWNERS: Record<string, string> = { backend: 'Joe', product: 'Jason' };

export function buildInterviewPrompt(packet: Packet): string {
  return [
    'You are Forge Intake\'s planner, and this is the interview that comes before the',
    'brief. One ticket is below. Decide two things: which side of the stack it belongs',
    'to, and what you would have to be told before you could write a plan that does not',
    'guess.',
    '',
    'Ticket:',
    JSON.stringify(packet),
    '',
    `Ask at most ${MAX_QUESTIONS} questions. Fewer is better and none is fine. A question`,
    'you can decide from the evidence in front of you is not a question -- decide it and',
    'leave it out. Never ask something whose answer only changes wording.',
    '',
    'Write every question in plain first person, the way one developer types to another:',
    '"Do we hide the row or show a zero?", never "The operator should clarify whether".',
    'No preamble, one idea per question, and never name a tool, a session or an agent.',
    '',
    'Tag each question with who can answer it:',
    '  "repo"     -- answerable by reading the checked-out code, and nothing else.',
    '  "aaron"    -- a decision only the operator can make.',
    '  "teammate" -- someone else on the team owns the answer. Set "topic" to "backend"',
    '                for anything about the API or the database, "product" for anything',
    '                about what a user should see, or set "who" to the person by name.',
    '',
    'If the ticket is backend-only -- nothing in it changes the app a user touches --',
    'set "route" to "backend", ask nothing, and put the one sentence the backend owner',
    'needs into "ask". Otherwise set "route" to "frontend".',
    '',
    'Reply with JSON only:',
    '{"route":"frontend"|"backend","ask":"...","questions":[{"text":"...",',
    '"options":["..."],"recommended":0,"answerableBy":"repo"|"aaron"|"teammate",',
    '"topic":"backend"|"product","who":"..."}]}',
  ].join('\n');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseQuestion(raw: unknown): InterviewQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const text = textOf(row['text']).trim();
  if (!text) return null;
  const answerableBy = textOf(row['answerableBy']) as AnswerableBy;
  if (answerableBy !== 'repo' && answerableBy !== 'aaron' && answerableBy !== 'teammate') return null;
  const options = Array.isArray(row['options'])
    ? row['options'].filter((o): o is string => typeof o === 'string')
    : [];
  // Bounds-checked against the options it indexes into: an out-of-range number reaches
  // the question card's recommendation badge and `answer-by-number`, both of which index
  // straight into `options`. `null` means "nobody picked one", which those already handle.
  // Found by code review, 2026-09-11.
  const pick = row['recommended'];
  const recommended = typeof pick === 'number' && Number.isInteger(pick) && pick >= 0 && pick < options.length
    ? pick
    : null;
  const topic = textOf(row['topic']).trim();
  const named = textOf(row['who']).trim();
  const who = named || (answerableBy === 'teammate' ? TOPIC_OWNERS[topic] ?? '' : '');
  return {
    text, options, recommended, answerableBy,
    ...(who ? { who } : {}),
    ...(topic ? { topic } : {}),
  };
}

/**
 * One interview pass over one ticket. Never raises an ask and never writes anything --
 * the caller decides what to do with the questions it gets back.
 *
 * A reply this cannot parse reads as no questions rather than an error: a ticket whose
 * interview failed still deserves a brief, and the planner's own failure path is a
 * worse outcome than a brief written without the extra facts.
 */
export async function interview(
  packet: Packet, reasoner: Reasoner, opts: { append?: JournalAppend } = {},
): Promise<InterviewResult> {
  const reply = await reasoner.call({ className: 'plan-ticket', prompt: buildInterviewPrompt(packet) });
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    return { route: 'frontend', questions: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { route: 'frontend', questions: [] };
  const row = parsed as Record<string, unknown>;
  const route = row['route'] === 'backend' ? 'backend' : 'frontend';
  if (route === 'backend') {
    return { route, questions: [], ask: textOf(row['ask']).trim() };
  }
  const all = (Array.isArray(row['questions']) ? row['questions'] : [])
    .map(parseQuestion)
    .filter((q): q is InterviewQuestion => q !== null);
  const kept = all.slice(0, MAX_QUESTIONS);
  if (all.length > kept.length) {
    opts.append?.({
      event: 'interview.capped', actor: 'intake', ticket: packet.ticket,
      packetId: packet.id, asked: all.length, kept: kept.length, dropped: all.length - kept.length,
    });
  }
  return { route, questions: kept };
}

/**
 * The word the planner emits INSTEAD OF a brief when two settled decisions cannot both
 * hold. It has to be a word a brief would never open with, because the signal is
 * recognised by position: first non-blank line only. A sentinel matched anywhere in the
 * document would let a brief that merely discusses a contradiction hold the ticket, which
 * is a worse failure than missing one.
 */
export const CONFLICT_SENTINEL = 'CONTRADICTION';

export interface ConflictSignal {
  question: string;
  options: string[];
}

/**
 * Reads a planner reply that refused to write a brief. Returns null for every ordinary
 * brief, which is the common case and must never be held.
 *
 * Shape, both lines optional after the first:
 *   CONTRADICTION: <why the two decisions cannot both hold, ending in a question>
 *   OPTIONS: <one choice> | <another choice>
 */
export function readConflictSignal(text: string): ConflictSignal | null {
  const lines = text.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return null;
  const first = lines[firstIndex]!.trim();
  if (!first.startsWith(`${CONFLICT_SENTINEL}:`)) return null;

  const question = first.slice(CONFLICT_SENTINEL.length + 1).trim();
  // A sentinel with nothing after it is not a question a person can answer; treat it as
  // no signal rather than raising an empty ask nobody can act on.
  if (!question) return null;

  const optionLine = lines.slice(firstIndex + 1).find((line) => line.trim().startsWith('OPTIONS:'));
  const options = optionLine
    ? optionLine.trim().slice('OPTIONS:'.length).split('|').map((o) => o.trim()).filter(Boolean)
    : [];
  return { question, options };
}

export function buildBriefPrompt(packet: Packet, answers: InterviewAnswer[]): string {
  const decisions = answers.length
    ? answers.map((a, i) => `${i + 1}. ${a.question}\n   Answer (${a.answeredBy}): ${a.answer}`)
    : ['(none -- the interview raised no questions)'];
  return [
    'You are Forge Intake\'s planner. One ticket is queued below, already interviewed.',
    'Write its goal brief: what to fix, its acceptance, nothing that launches anything.',
    '',
    'Ticket:',
    JSON.stringify(packet),
    '',
    'Answers already settled. Treat every one as decided and never ask again:',
    ...decisions,
    '',
    'The brief you write becomes instructions for a worker agent with no device and no',
    'eyes. Verification splits two ways: the worker verifies whatever a test can reach,',
    'and QA verifies whatever a human eye has to see. Never ask the worker to run on a',
    'device or an emulator, take a screenshot, or confirm something looks right, and',
    'never list a screenshot or a visual check as acceptance. Tests are behaviour tests',
    'only. State every acceptance criterion so it is observable straight from a tool',
    'call -- a named test file, a file path, an exact string, a status code. Demand a',
    'full, working implementation, never a stub or a hardcoded literal standing in for',
    'the real path. The worker opens a draft PR only.',
    '',
    'End the brief with a "## Decisions" section repeating each question above, its',
    'answer and who gave it, so the worker never re-litigates a settled call.',
    '',
    'Set your `text` field to the full brief as Markdown, starting with a "# Goal:"',
    'heading.',
    '',
    'One check before you write it. Read the settled answers against each other and ask',
    'whether any two of them are incompatible -- not merely different, but impossible to',
    'satisfy at the same time, so that building one breaks the other. This is the thing',
    'that is cheap to see now and expensive to discover halfway through the work.',
    '',
    'If two are incompatible, write NO brief. Set your `text` field so that its first',
    `line is \`${CONFLICT_SENTINEL}: \` followed by which decisions collide, why they`,
    'cannot both hold, and a question asking which one to keep. Nothing may come before',
    'that first line. On the next line write',
    '`OPTIONS: ` and the concrete choices separated by `|`. Write nothing else.',
    '',
    'If they are compatible, say nothing about it and write the brief. Most tickets have',
    'no conflict, and holding one on an imagined conflict costs more than it saves.',
  ].join('\n');
}

/** The second and last reasoner call of a planning hop: the brief, written with every
 *  answer in hand. */
export async function writeBrief(
  packet: Packet, answers: InterviewAnswer[], reasoner: Reasoner,
): Promise<PlannedBrief> {
  const result = await reasoner.call({ className: 'plan-ticket', prompt: buildBriefPrompt(packet, answers) });
  return { packetId: packet.id, ticket: packet.ticket, text: result.text };
}
