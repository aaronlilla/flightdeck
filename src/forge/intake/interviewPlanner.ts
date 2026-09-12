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
import {
  interview, writeBrief, type InterviewAnswer, type InterviewQuestion, type JournalAppend,
} from './interview.ts';
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

/**
 * Journals `interview.answered` at the one condition every answer-delivery surface
 * shares: the closed ask belongs to an item (`item:<id>`, minted by `askRunFor`), never
 * an ordinary worker ask. Called from every place an ask is actually answered --
 * `/answer`, the console's own `answer <key> <text>` command, `forge answer`, and the
 * auto-answer rule -- rather than from one route alone, so the row fires wherever the
 * shipped app actually delivers an answer, not only where a test happens to call in.
 */
export function journalInterviewAnswer(append: JournalAppend | undefined, answered: InboxEntry): void {
  const itemRun = answered.runs.find((run) => run.startsWith(ITEM_RUN_PREFIX));
  if (itemRun === undefined) return;
  append?.({
    event: 'interview.answered',
    itemId: itemRun.slice(ITEM_RUN_PREFIX.length),
    ticket: answered.ticket,
    askKey: answered.key,
    answeredBy: answeredByOf(answered),
  });
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
    result = await interview(packet, deps.reasoner, {
      ...(deps.append ? { append: deps.append } : {}),
    });
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
    // says an item is held, never why. Written once per ask that actually creates a new
    // inbox entry: `entry.asked === 1` is `raise`'s own signal for that, so two questions
    // in this loop that normalise to the same key (identical text and options) get one
    // row, matching the one ask `raise` actually left on disk -- never two rows sharing
    // an askKey. A repo question the scout answered above never reaches this line at all.
    if (entry.asked === 1) {
      deps.append?.({
        event: 'interview.asked', itemId, ticket, askKey: entry.key,
        answerableBy: forPerson.answerableBy, question: entry.question,
        ...(forPerson.who ? { who: forPerson.who } : {}),
      });
    }
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

/** Marks the follow-up ask `findKnownContradiction` raises, and doubles as the guard
 *  against re-raising it: once that ask is answered, its own question text (carrying
 *  this marker) is itself one of the settled answers on the next hop, so the same two
 *  original decisions never fire the check twice. */
const CONTRADICTION_MARKER = 'single-tap-vs-shared-component contradiction';

/**
 * Item 11 (2026-09-11): a live round trip cost twenty minutes into implementation
 * because two settled decisions read as fine independently and were incompatible
 * together -- "build outside-press dismissal into the shared component" and "a single
 * tap should both close the drop-down and activate whatever was tapped". Whatever view
 * sits under the finger at those coordinates is the only touch target in React Native,
 * so a backdrop confined to the shared component necessarily swallows the tap it closes
 * on; true single-tap dismiss-and-activate needs a listener placed ABOVE the component.
 *
 * This is ONE narrow, evidenced rule for that one known-shape conflict, not a general
 * contradiction detector -- a false positive that parks every ticket on an imagined
 * contradiction is worse than the bug this fixes. It matches only when both halves of
 * the specific conflict are present in the answer text; it will not catch a
 * differently-worded version of the same conflict, and it never inspects the
 * repository -- it reads the collected decisions only.
 */
/**
 * Whether an answer ASKS FOR a second tap, rather than ruling one out. The distinction
 * is the whole check: "do not require a second tap" is the conflict, and "require a
 * second tap to activate" is the conflict already resolved. Matching the phrase either
 * way made the detector negation-blind and parked items on a settled decision -- found
 * by code review, 2026-09-12.
 */
function requiresASecondTap(answer: string): boolean {
  const mentions = /(second tap|two taps|tap again)/i.test(answer);
  if (!mentions) return false;
  const ruledOut = /(do not|don'?t|never|no|without|rather than|instead of)[^.]{0,40}(second tap|two taps|tap again)/i
    .test(answer);
  return !ruledOut;
}

export function findKnownContradiction(answers: InterviewAnswer[]): string | undefined {
  if (answers.some((a) => a.question.includes(CONTRADICTION_MARKER))) return undefined;
  const buildsDismissalIntoSharedComponent = answers.some(
    (a) => /shared|reusable/i.test(a.answer)
      && /component/i.test(a.answer)
      && /(outside[- ]press|backdrop|dismiss)/i.test(a.answer),
  );
  // `second tap` was in the positive alternation until code review, 2026-09-12, which
  // made the check negation-blind: an interview that had already settled on resolution
  // (a) -- "a single tap closes it, a second tap activates" -- matched every half and
  // parked the item on a follow-up nobody needed. That answer is the conflict RESOLVED,
  // not the conflict. The conflict is one tap doing both, so any wording that hands the
  // activation to a second tap disqualifies the match.
  const wantsSingleTapThrough = answers.some(
    (a) => /single tap/i.test(a.answer)
      && /(close|dismiss)/i.test(a.answer)
      && /(activate|go through)/i.test(a.answer)
      && !requiresASecondTap(a.answer),
  );
  if (!buildsDismissalIntoSharedComponent || !wantsSingleTapThrough) return undefined;
  return `${CONTRADICTION_MARKER}: two earlier decisions conflict. One says the `
    + 'outside-press dismissal belongs in the shared component; another says a single '
    + 'tap must both close the drop-down and activate whatever is under it. In React '
    + 'Native, whatever view sits on top at those coordinates is the only touch target '
    + '-- a backdrop confined to the shared component will swallow the tap it closes on, '
    + 'so true single-tap dismiss-and-activate needs a listener placed above the '
    + 'component instead. Which do you want: (a) keep the dismissal in the shared '
    + 'component and accept that a second tap activates the element, or (b) move the '
    + 'dismiss listener above the component so one tap does both?';
}

async function finishBrief(
  packet: Packet, answers: InterviewAnswer[], ticket: string, itemId: string, deps: InterviewPlannerDeps,
): Promise<QueuePlanOutcome> {
  const contradiction = findKnownContradiction(answers);
  if (contradiction) {
    const entry = deps.inbox.raise({
      run: askRunFor(itemId),
      question: contradiction,
      // The question spells out two choices in prose; without them as options the card
      // showed nothing selectable and answer-by-number was dead (code review,
      // 2026-09-12).
      options: [
        'keep the dismissal in the shared component and accept that a second tap activates the element',
        'move the dismiss listener above the component so one tap does both',
      ],
      recommended: null,
      optionSource: 'drafted',
      kind: 'question',
      ticket,
      actionTarget: 'interview',
    });
    if (entry.asked === 1) {
      deps.append?.({
        event: 'interview.asked', itemId, ticket, askKey: entry.key,
        answerableBy: 'aaron', question: entry.question,
      });
    }
    // Carry forward only what never touched the inbox (scout answers): whatever is
    // already an inbox entry for this item comes back through `asksForItem` on its own
    // next hop, and re-storing it here would double it up in the merged answer list.
    const inboxQuestions = new Set(asksForItem(deps.inbox, itemId).map((entry2) => entry2.question));
    const carryForward = answers.filter((a) => !inboxQuestions.has(a.question));
    deps.records.put({ itemId, ticket, at: Date.now(), answers: carryForward });
    return { waiting: 'interview', asks: 1 };
  }
  const brief = await writeBrief(packet, answers, deps.reasoner);
  const written = await deps.writeBriefFile({ ticket, itemId, text: brief.text });
  deps.records.clear(itemId);
  return { ticket, repo: written.repo, briefPath: written.briefPath };
}
