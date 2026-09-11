/**
 * The planning hop's own orchestration (roadmap R-76): interview the ticket, answer what
 * the checkout can answer, raise the rest as asks, and write the brief once every ask is
 * answered.
 *
 * Everything the queue needs to know about this lives in the three shapes
 * `QueuePlanOutcome` already carries -- a planned brief, `waiting`, or a backend route --
 * so `queue.ts` gains three branches and no knowledge of interviews.
 *
 * An open question holds ONE item, never the queue: the item stays in `planning` with a
 * `queue.waiting` row, and every other row on the tick advances untouched. It is never
 * parked, because a parked item has no wake path (`runQueueTick` advances only
 * `planning`, `running` and `queued`) and would wait for a person to click Retry.
 */
import type { Packet, Reasoner } from '../contracts.ts';
import type { Inbox, InboxEntry } from '../inbox.ts';
import { interview, writeBrief, type InterviewAnswer, type InterviewQuestion, type JournalAppend } from './interview.ts';
import type { InterviewRecords } from './interviewStore.ts';
import type { QueuePlanOutcome } from './queue.ts';
import type { ScoutAnswer } from './scout.ts';

/** The `Ask.run` an item-scoped question carries. `Ask.run` is required and everything
 *  downstream is keyed to a run, so an item borrows the shape rather than changing it:
 *  `askKey`, the board's strip and `POST /answer` all work unchanged. */
export function askRunFor(itemId: string): string {
  return `item:${itemId}`;
}

export function asksForItem(inbox: Inbox, itemId: string): InboxEntry[] {
  const run = askRunFor(itemId);
  return inbox.all().filter((entry) => entry.runs.includes(run));
}

export interface InterviewPlannerDeps {
  reasoner: Reasoner;
  inbox: Inbox;
  /** The ticket as a packet -- whatever the caller already reads to plan one. */
  packetFor: (ticket: string) => Promise<Packet>;
  /** One `repo` question against the checkout. */
  scout: (question: InterviewQuestion, packet: Packet) => Promise<ScoutAnswer>;
  /** Writes the brief where the rest of the pipeline expects it, and answers with its
   *  path and the repository it routed to. */
  writeBriefFile: (input: { ticket: string; itemId: string; text: string }) => Promise<{ briefPath: string; repo: string }>;
  /** Holds what the scout settled while the item waits on a person. */
  records: InterviewRecords;
  append?: JournalAppend;
}

function answeredByOf(entry: InboxEntry): string {
  return entry.answeredBy ?? 'Aaron';
}

function answersFrom(entries: InboxEntry[]): InterviewAnswer[] {
  return entries.map((entry) => ({
    question: entry.question,
    answer: entry.answer ?? '',
    answeredBy: answeredByOf(entry),
  }));
}

/**
 * One planning hop for one ticket. Called once per tick while the item sits in
 * `planning`, and idempotent across those calls: a hop that finds an unanswered ask
 * returns `waiting` without a single reasoner call, so an item held for a day costs
 * nothing per tick.
 */
export async function planTicketWithInterview(
  ticket: string, itemId: string, deps: InterviewPlannerDeps,
): Promise<QueuePlanOutcome> {
  const existing = asksForItem(deps.inbox, itemId);
  if (existing.length) {
    const unanswered = existing.filter((entry) => entry.answer === undefined);
    if (unanswered.length) return { waiting: 'interview', asks: unanswered.length };
    const packet = await deps.packetFor(ticket);
    const settled = deps.records.get(itemId)?.answers ?? [];
    return finishBrief(packet, [...settled, ...answersFrom(existing)], ticket, itemId, deps);
  }

  const packet = await deps.packetFor(ticket);
  const result = await interview(packet, deps.reasoner, { ...(deps.append ? { append: deps.append } : {}) });
  if (result.route === 'backend') {
    return { backend: true, ticket, ask: result.ask ?? '' };
  }

  const answers: InterviewAnswer[] = [];
  let raised = 0;
  for (const question of result.questions) {
    let forPerson = question;
    let note = '';
    if (question.answerableBy === 'repo') {
      const found = await deps.scout(question, packet);
      if (found.answered) {
        answers.push({
          question: question.text,
          answer: found.citation ? `${found.text} (${found.citation})` : found.text,
          answeredBy: 'the repo',
        });
        continue;
      }
      // A scout that cannot answer does not get to drop the question: it becomes the
      // operator's, with what the scout did look at attached so nobody repeats it.
      forPerson = { ...question, answerableBy: 'aaron' };
      note = found.text;
    }
    deps.inbox.raise({
      run: askRunFor(itemId),
      question: note ? `${forPerson.text}\n\n(looked in the code first: ${note})` : forPerson.text,
      options: forPerson.options,
      recommended: forPerson.recommended,
      optionSource: 'drafted',
      kind: 'question',
      ticket,
      actionTarget: forPerson.answerableBy === 'teammate' && forPerson.who ? `teammate:${forPerson.who}` : 'interview',
    });
    raised += 1;
  }

  if (raised > 0) {
    // The scout's findings outlive this tick: the tick that writes the brief runs after
    // the answer arrives, and re-deriving them there would cost a second grep and could
    // cite different evidence than the interview saw.
    deps.records.put({ itemId, ticket, at: Date.now(), answers });
    return { waiting: 'interview', asks: raised };
  }
  return finishBrief(packet, answers, ticket, itemId, deps);
}

async function finishBrief(
  packet: Packet, answers: InterviewAnswer[], ticket: string, itemId: string, deps: InterviewPlannerDeps,
): Promise<QueuePlanOutcome> {
  const brief = await writeBrief(packet, answers, deps.reasoner);
  const written = await deps.writeBriefFile({ ticket, itemId, text: brief.text });
  deps.records.clear(itemId);
  return { ticket, repo: written.repo, briefPath: written.briefPath };
}
