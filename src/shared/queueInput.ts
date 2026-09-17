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
export type QueueInputReading =
  | { source: QueueSource; input: string; says: string; refused?: boolean }
  | null;

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

/** An `owner/name` pair and nothing else. */
export function isRepoName(text: string): boolean {
  const slash = text.indexOf('/');
  if (slash < 1 || slash !== text.lastIndexOf('/') || slash === text.length - 1) return false;
  const ok = (part: string): boolean => /^[A-Za-z0-9_.-]+$/.test(part);
  return ok(text.slice(0, slash)) && ok(text.slice(slash + 1));
}

/**
 * A brief carrying the repository it belongs to.
 *
 * A pasted brief has no ticket, so nothing routes it, and it lands on whichever
 * repository the rules call the default. That is how a brief about this console's own
 * queue screen was provisioned into the mobile app, where the code it describes does not
 * exist -- the run had to stop and ask (measured 2026-09-12).
 *
 * The line is the seam the intake already reads: `repo: owner/name` in the first twenty
 * lines wins over every rule. Putting it there rather than inventing a new field means
 * the brief on disk says where it belongs, so anyone reading the file later can see it.
 */
export function briefWithRepo(text: string, repo: string): string {
  return `repo: ${repo}

${text}`;
}

export function readQueueInput(raw: string, repo = ''): QueueInputReading {
  const text = raw.trim();
  if (text.length === 0) return null;
  const named = repo.trim();
  if (named.length > 0 && !isRepoName(named)) {
    return { source: 'brief', input: text, says: `"${named}" is not a repository; write it as owner/name.`, refused: true };
  }
  if (isTicketKey(text)) {
    // A ticket is routed by its own key, its labels and its component, so naming a
    // repository here would be a second answer to a question already answered.
    return { source: 'ticket', input: text.toUpperCase(), says: `Reads as the ticket ${text.toUpperCase()}.` };
  }
  if (isJql(text)) {
    return { source: 'query', input: text, says: 'Reads as a Jira search; every ticket it matches is added.' };
  }
  if (named.length > 0) {
    return { source: 'brief', input: briefWithRepo(text, named), says: `Reads as a brief, for ${named}.` };
  }
  return { source: 'brief', input: text, says: 'Reads as a brief in your own words. Name a repository, or it goes to the default one.' };
}
