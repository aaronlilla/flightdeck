/**
 * X4: the rail thread's router, behind the `Reasoner` seam the contracts already
 * declare. A message typed into the console's rail is classified by a Haiku call and
 * acted on by a Sonnet call, never the other way round: classification is cheap and
 * has to run on every message, acting is where a wrong guess costs something.
 *
 * Both calls go through `Reasoner`, contracts.ts's own interface, so a specimen hands
 * this a fake and nothing here can reach a real model. `route()` never calls a
 * `Reasoner` at all when the caller says the router is off -- see `routerEnabled` in
 * `policy.ts` -- which is the mechanism behind "live routing stays off until Aaron
 * turns `router.enabled` on."
 */
import type { Reasoner } from './contracts.js';
import type { Inbox, InboxEntry } from './inbox.js';
import type { Journal } from './journal.js';
import { deliverAnswer } from './runinbox.js';
import { journalInterviewAnswer } from './intake/interviewPlanner.js';

/** Haiku classifies; Sonnet acts. Both are existing model-policy classes, chosen for
 *  the cost/latency the two steps actually need rather than new classes invented for
 *  this one feature. */
export const ROUTER_CLASSIFY_CLASS = 'evaluate';

export const ROUTER_ACT_CLASS = 'triage';

export type RouterClass = 'answer' | 'intake' | 'question' | 'system';

const ROUTER_CLASSES: readonly RouterClass[] = ['answer', 'intake', 'question', 'system'];

export interface RouterContext {
  inbox: Inbox;
  journal: Pick<Journal, 'append'>;
  /** A read-only view for the `question` class: what `/state` and the journal already
   *  know, rendered as text the act call can quote from rather than guess at. */
  stateSummary: () => string;
  openAsks: () => InboxEntry[];
}

export type RouterOutcome =
  | { class: 'answer'; key: string; answer: string; delivered: boolean }
  | { class: 'intake'; text: string; reason?: string }
  | { class: 'question'; answer: string }
  | { class: 'system'; kind: 'gotcha' | 'proposal'; text: string };

function parseClassification(raw: string): RouterClass {
  const normalized = raw.trim().toLowerCase();
  const found = ROUTER_CLASSES.find((candidate) => normalized.includes(candidate));
  // A classification the model could not make legible falls to `intake` rather than
  // being dropped: new work reaching Intake unnecessarily costs a look; an answer or a
  // question silently going nowhere costs someone waiting on a run that never resumes.
  return found ?? 'intake';
}

export async function classify(reasoner: Reasoner, text: string): Promise<RouterClass> {
  const { text: raw } = await reasoner.call({
    className: ROUTER_CLASSIFY_CLASS,
    prompt: [
      'Classify this message from an operator watching a fleet of automated runs into',
      'exactly one word: answer, intake, question, or system.',
      '- answer: it responds to a question a parked run is waiting on.',
      '- intake: it describes new work nobody has started yet.',
      '- question: it asks what the fleet is doing, answerable from current state.',
      '- system: it is an instruction about the fleet itself (a gotcha, a policy change).',
      '',
      `Message: ${text}`,
    ].join('\n'),
  });
  return parseClassification(raw);
}

/**
 * Route one message: classify it, then act on the classification. `route` never calls
 * `classify` a run has already told us the class for (a future caller may skip
 * straight to `act` once the classification is known), so the two are exported
 * separately rather than only as one combined function.
 */
export async function act(
  reasoner: Reasoner,
  cls: RouterClass,
  text: string,
  ctx: RouterContext,
): Promise<RouterOutcome> {
  if (cls === 'intake') {
    ctx.journal.append({ event: 'intake.requested', actor: 'router', note: text });
    return { class: 'intake', text };
  }

  if (cls === 'answer') {
    const open = ctx.openAsks();
    const { text: raw } = await reasoner.call({
      className: ROUTER_ACT_CLASS,
      prompt: [
        'One of these open questions is what this message answers. Reply with exactly',
        'two lines: the key, then the answer text.',
        '',
        ...open.map((entry) => `${entry.key}: ${entry.question}`),
        '',
        `Message: ${text}`,
      ].join('\n'),
    });
    const [keyLine, ...answerLines] = raw.trim().split('\n');
    const key = (keyLine ?? '').trim();
    const answer = answerLines.join('\n').trim() || text;
    const match = open.find((entry) => entry.key === key);
    if (!match) {
      // The model named a key that is not actually open: acted on nothing rather than
      // guess at which question was meant, and the message still reaches Intake so it
      // is not silently lost.
      ctx.journal.append({ event: 'intake.requested', actor: 'router', note: text });
      return { class: 'intake', text, reason: `router could not match an open ask to "${key}"` };
    }
    const answered = ctx.inbox.answer(key, answer);
    const delivered = Boolean(answered);
    if (answered) {
      await deliverAnswer(answered, key, answer);
      journalInterviewAnswer((row) => ctx.journal.append(row), answered);
    }
    return { class: 'answer', key, answer, delivered };
  }

  if (cls === 'question') {
    const { text: answer } = await reasoner.call({
      className: ROUTER_ACT_CLASS,
      prompt: [
        'Answer this question about the fleet using only the state below. Read-only:',
        'take no action, just answer in plain text.',
        '',
        ctx.stateSummary(),
        '',
        `Question: ${text}`,
      ].join('\n'),
    });
    return { class: 'question', answer: answer.trim() };
  }

  // system
  const { text: raw } = await reasoner.call({
    className: ROUTER_ACT_CLASS,
    prompt: [
      'This message is an instruction about the fleet itself, not about one run.',
      'Reply with exactly one word: gotcha (something went wrong and should not',
      'happen again) or proposal (a change someone should consider).',
      '',
      `Message: ${text}`,
    ].join('\n'),
  });
  const kind = raw.trim().toLowerCase().includes('gotcha') ? 'gotcha' : 'proposal';
  ctx.journal.append({ event: kind, actor: 'router', note: text });
  return { class: 'system', kind, text };
}

export async function route(reasoner: Reasoner, text: string, ctx: RouterContext): Promise<RouterOutcome> {
  const cls = await classify(reasoner, text);
  return act(reasoner, cls, text, ctx);
}
