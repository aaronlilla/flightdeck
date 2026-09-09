/**
 * The rail's three registers.
 *
 * Most of a rail is not the repo's prose. An `operator` row is what Aaron typed, a
 * `reply` is what the agent wrote back, a `question` is the agent's own question, a `pr`
 * row carries a pull request title somebody wrote on GitHub, and a `plan`, `confirm`,
 * `blocker` or `decision` card is the agent speaking. Narrating any of those would be
 * rewriting a person -- so they pass through `Binder.verbatim`, which cannot reach the
 * model and writes no cache key. Three identical registers, no call, by construction.
 *
 * What is left is the rows this repo composed about its own state: `event`, `activity`
 * and `receipt`. Those are narrated.
 */
import type { Message, MessageType, NarrationBag, NarrationFacts } from '../../shared/console-model.js';

import { Binder } from './narrate-bind.js';
import type { Narrator } from './narrate-store.js';

/** The row types this repo wrote itself. Everything else is somebody's own words. */
const NARRATED_TYPES: ReadonlySet<MessageType> = new Set<MessageType>(['event', 'activity', 'receipt']);

/**
 * A rail row's protected facts: the clock times and the pull request number it states.
 * A rail row has no structured record behind it -- it is composed from one journal row --
 * so the values worth protecting are the ones a reworded sentence could move. Bare counts
 * are left to the template rule, which already forces `glance` to carry every number its
 * own sentence carries.
 */
export function railFactsFor(message: Message): NarrationFacts | null {
  if (!message.text.trim()) return null;
  const facts: Record<string, string | number | boolean | null> = {};
  const times = message.text.match(/\b\d{1,2}:\d{2}\b/g) ?? [];
  times.forEach((time, index) => { facts[`time${index + 1}`] = time; });
  const pr = /#(\d+)/.exec(message.text);
  if (pr) facts['pr'] = Number(pr[1]);
  return { surface: `rail.${message.type}`, facts: facts as NarrationFacts['facts'], template: message.text };
}

/** One rail row with its registers attached. */
export function narrateMessage(message: Message, narrator: Narrator | null): Message {
  const bag: NarrationBag = {};
  // The rail is a lane's own thread, so a landed narration refreshes the `lanes` slice;
  // there is no separate rail slice and inventing one would break the events contract.
  const binder = new Binder(narrator, 'lanes');
  if (!NARRATED_TYPES.has(message.type)) {
    binder.verbatim(bag, 'text', message.text);
    return { ...message, narration: bag };
  }
  const text = binder.field(bag, 'text', railFactsFor(message), message.k);
  return { ...message, ...(text === null ? {} : { text }), narration: bag };
}

export function narrateThread(messages: Message[], narrator: Narrator | null): Message[] {
  return messages.map((message) => narrateMessage(message, narrator));
}
