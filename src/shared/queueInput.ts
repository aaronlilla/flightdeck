import type { QueueSource } from './console-model.js';

/**
 * What a person meant by what they typed into the queue's Add box.
 *
 * The queue takes six kinds of input and the server needs to be told which one it is
 * getting. Asking that as a dropdown is a question nobody should have to answer: a ticket
 * key, a Jira search and a paragraph of prose do not look remotely alike, and reading
 * which is which is the console's job. So one box, and this decides.
 *
 * It never guesses silently. The Add control shows the answer back before anything is
 * sent -- "this reads as a ticket key" -- so a wrong reading is visible rather than
 * surprising, and the person can rewrite it.
 *
 * `null` means there is nothing to add, which is the empty box.
 */
export type QueueInputReading = { source: QueueSource; input: string; says: string } | null;

/** A whole line that is nothing but a ticket key: `BBZ-289`, `bbz-289`, `SCRUM-4`. */
function isTicketKey(text: string): boolean {
  if (text.includes(' ') || text.includes('\n')) return false;
  const dash = text.indexOf('-');
  if (dash < 1 || dash === text.length - 1) return false;
  const project = text.slice(0, dash);
  const number = text.slice(dash + 1);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(project)) return false;
  return /^[0-9]+$/.test(number);
}

/**
 * A Jira search rather than a sentence. Two signals together, because either alone is
 * wrong: "project = BBZ" has a comparison, and "and the label is wrong" has the word
 * `and` -- a search needs a field-shaped comparison, and English does not have those.
 */
function isJql(text: string): boolean {
  if (text.includes('\n')) return false;
  const lower = text.toLowerCase();
  const hasField = /(^|\s)(project|assignee|status|labels?|sprint|reporter|type|priority|fixversion)\s*(=|!=|~|\bin\b|\bwas\b)/i.test(text);
  const hasOrder = lower.includes('order by');
  return hasField || hasOrder;
}

export function readQueueInput(raw: string): QueueInputReading {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (isTicketKey(text)) {
    return { source: 'ticket', input: text.toUpperCase(), says: `Reads as the ticket ${text.toUpperCase()}.` };
  }
  if (isJql(text)) {
    return { source: 'query', input: text, says: 'Reads as a Jira search; every ticket it matches is added.' };
  }
  return { source: 'brief', input: text, says: 'Reads as a brief in your own words.' };
}
