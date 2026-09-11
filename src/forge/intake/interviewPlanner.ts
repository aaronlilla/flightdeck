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
import { ITEM_RUN_PREFIX, type Inbox, type InboxEntry } from '../inbox.ts';
import { interview, writeBrief, type InterviewAnswer, type InterviewQuestion, type JournalAppend } from './interview.ts';
import type { InterviewRecords } from './interviewStore.ts';
import type { QueuePlanOutcome } from './queue.ts';
import type { ScoutAnswer } from './scout.ts';

/** The `Ask.run` an item-scoped question carries. `Ask.run` is required and everything
 *  downstream is keyed to a run, so an item borrows the shape rather than changing it:
 *  `askKey`, the board's strip and `POST /answer` all work unchanged. */
export function askRunFor(itemId: string): string {
  return `${ITEM_RUN_PREFIX}${itemId}`;
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

/**
 * Who the brief says decided this.
 *
 * `answeredBy` names whoever replied in Slack, and that reply is attached WITHOUT being
 * accepted -- the operator still confirms or changes it. So a teammate is credited only
 * when the stored answer is the teammate's own words; the moment the operator types
 * something else, the decision is the operator's and the brief has to say so. Crediting a
 * teammate with a call they did not make is worse than saying nothing: the worker reads
 * `## Decisions` as settled and never asks again. Found by code review, 2026-09-11.
 */
export function answeredByOf(entry: InboxEntry): string {
  if (entry.answeredBy && entry.reply !== undefined && entry.answer === entry.reply) {
    return entry.answeredBy;
  }
  return 'the operator';
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
/** How long one item's interview lease holds off a re-entering hop. An interview plus
 *  its scouting takes about a minute; a lease left behind by a crashed process expires
 *  rather than holding the ticket forever. */
export const INTERVIEW_LEASE_MS = 10 * 60 * 1000;

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

  // The lease: a hop that re-enters this item while its interview is still out (the
  // same process on a later tick, or a restarted process replaying `planning` items)
  // must not start a second interview. Nothing has been raised yet, so the ask check
  // above cannot catch it; this record can.
  const now = Date.now();
  const prior = deps.records.get(itemId);
  if (prior?.inFlightAt !== undefined && now - prior.inFlightAt < INTERVIEW_LEASE_MS) {
    return { waiting: 'interview', asks: 0 };
  }
  deps.records.put({ itemId, ticket, at: now, answers: prior?.answers ?? [], inFlightAt: now });

  const packet = await deps.packetFor(ticket);
  let result: Awaited<ReturnType<typeof interview>>;
  try {
    result = await interview(packet, deps.reasoner, { ...(deps.append ? { append: deps.append } : {}) });
  } catch (error) {
    deps.records.clear(itemId);
    throw error;
  }
  if (result.route === 'backend') {
    deps.records.clear(itemId);
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
    const entry = deps.inbox.raise({
      run: askRunFor(itemId),
      question: note ? `${forPerson.text}\n\n(looked in the code first: ${note})` : forPerson.text,
      options: forPerson.options,
      recommended: forPerson.recommended,
      optionSource: 'drafted',
      kind: 'question',
      ticket,
      actionTarget: forPerson.answerableBy === 'teammate' && forPerson.who ? `teammate:${forPerson.who}` : 'interview',
    });
    // The Flow page's only record of what was asked and who owns it -- `queue.waiting`
    // says an item is held, never why. Written here, once per ask actually raised, so a
    // repo question the scout answered above never gets one.
    deps.append?.({
      event: 'interview.asked', itemId, ticket, askKey: entry.key, answerableBy: forPerson.answerableBy,
    });
    raised += 1;
  }

  if (raised > 0) {
    // The scout's findings outlive this tick: the tick that writes the brief runs after
    // the answer arrives, and re-deriving them there would cost a second grep and could
    // cite different evidence than the interview saw. The lease ends here: the asks on
    // disk are what hold the item from now on.
    deps.records.put({ itemId, ticket, at: Date.now(), answers });
    return { waiting: 'interview', asks: raised };
  }
  deps.records.clear(itemId);
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
