/**
 * The one place machine identifiers are turned into words a person can read. Both halves
 * use it: the server when it renders a thread, a story or a reply, and the browser when it
 * echoes a command the operator clicked rather than typed.
 *
 * The rule (Aaron, 2026-09-08): by default nothing on the board shows a run id, an ask
 * key, a journal id, a packet id, a pid or a 40-character sha. A ticket key (`BBZ-226`) is
 * a name people use and stays. Anything stripped here is still there in verbose mode,
 * which every route answers under `?verbose=1` and which never goes through this file.
 */

/** A run id shaped like a self item, a chain run or a queue run. */
const RUN_ID_PATTERNS: RegExp[] = [
  /\bS-[0-9a-f]{12,}\b(?:-\d+)?/g,
  /\bjira_([A-Z]{2,6}-\d+)_\d{10,}(?:-\d+)?\b/g,
  /\bqueue-([A-Z]{2,6}-\d+)(?:-\d+)?\b/g,
  /\bqueue-brief-\d{10,}(?:-\d+)?\b/g,
];

/** A bare hex key at least 16 long that is not a git sha (asks, packets, tokens). */
const HEX_KEY = /\b[0-9a-f]{16,39}\b/g;
const LONG_SHA = /\b[0-9a-f]{40}\b/g;
const JOURNAL_ID = /\bJ-[0-9a-f]{6,}\b/g;
const TICKET_KEY = /(?<![A-Za-z])[A-Z]{2,6}-\d+(?!\d)/;

/** A ticket key found inside a run id (`jira_BBZ-226_178…`, `queue-BBZ-96-2`), or null. */
export function ticketInId(id: string): string | null {
  const match = TICKET_KEY.exec(id);
  return match ? match[0] : null;
}

/** Cuts every 40-character sha down to its first seven characters. */
export function shortenShas(text: string): string {
  return text.replace(LONG_SHA, (sha) => sha.slice(0, 7));
}

export interface StripOptions {
  /** Answers a person's name for an id (a ticket key, a title), or null. */
  labelFor?: (id: string) => string | null;
}

/**
 * Replaces every run id in `text` with its label (the ticket key inside it when nothing
 * better is known), drops bare hex keys and journal ids, and shortens shas. Never blanks
 * a sentence: an id that stands alone becomes "this run".
 */
export function stripMachineIds(text: string, options: StripOptions = {}): string {
  let out = text;
  for (const pattern of RUN_ID_PATTERNS) {
    out = out.replace(pattern, (id) => options.labelFor?.(id) ?? ticketInId(id) ?? 'this run');
  }
  out = shortenShas(out);
  out = out.replace(JOURNAL_ID, '');
  out = out.replace(HEX_KEY, '');
  out = out.replace(/\(\s*\)/g, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  return out || 'this run';
}

/** "parking on 19a6c631cb7783d8: Probe: continue?" -> "Asked you: Probe: continue?" */
export function humanizeParkReason(reason: string): string {
  const asked = /^parking on [0-9a-f]{8,}:\s*(.+)$/is.exec(reason.trim());
  if (asked) return `Asked you: ${asked[1]!.trim()}`;
  return stripMachineIds(reason);
}

export interface EchoContext {
  /** A person's name for a lane id or ticket key: the ticket key, else the title. */
  labelFor?: (id: string) => string | null;
  /** The question text behind an open or answered ask key, when known. */
  questionFor?: (askKey: string) => string | null;
}

/**
 * What the operator bubble says for a command. Typed text stays as typed; a command a
 * button produced (`answer <key> <option>`, `kill <run id>`, `confirm <token>`) is said the
 * way the operator would have said it out loud.
 */
export function commandEcho(command: string, context: EchoContext = {}): string {
  const text = command.trim();
  let match: RegExpMatchArray | null;
  const label = (id: string): string => context.labelFor?.(id) ?? ticketInId(id) ?? stripMachineIds(id, context);

  if ((match = text.match(/^answer\s+([0-9a-f]{8,})\s+(.+)$/i))) {
    return `Answered: ${match[2]!.trim()}`;
  }
  if ((match = text.match(/^answer\s+(.+)$/i))) return `Answered: ${match[1]!.trim()}`;
  if ((match = text.match(/^confirm\s+\S+$/i))) return 'Confirmed.';
  if ((match = text.match(/^(?:dismiss|decline)\s+\S+$/i))) return 'Not now.';
  if ((match = text.match(/^run\s+\S+$/i))) return 'Run the plan.';
  if ((match = text.match(/^kill\s+(\S+)$/i))) return `Kill ${label(match[1]!)}.`;
  if ((match = text.match(/^resume\s+(\S+)$/i))) return `Resume ${label(match[1]!)}.`;
  if ((match = text.match(/^pause\s+(\S+)$/i)) && !/^everything$/i.test(match[1]!)) return `Pause ${label(match[1]!)}.`;
  if ((match = text.match(/^cap\s+(\S+)\s+at\s+(.+)$/i))) return `Cap ${label(match[1]!)} at ${match[2]!} tokens.`;
  if ((match = text.match(/^why\s+is\s+(?:lane\s+)?(\S+)\s+stuck\??$/i))) return `Why is ${label(match[1]!)} stuck?`;
  return text;
}

/** A receipt's own text: "answered f92af4249f6a27ae" -> "Answered the question." and so on.
 *  Anything this does not recognise is passed through `stripMachineIds`. */
export function receiptText(text: string, context: EchoContext = {}): string {
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^answered\s+([0-9a-f]{8,})(?::\s*(.+))?$/i))) {
    const question = context.questionFor?.(match[1]!);
    const answer = match[2]?.trim();
    const head = question ? `Answered "${question.length > 70 ? `${question.slice(0, 70)}…` : question}"` : 'Answered the question';
    return answer ? `${head}: ${answer}` : `${head}.`;
  }
  return stripMachineIds(text, context);
}
