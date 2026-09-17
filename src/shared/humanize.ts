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

/** A run id shaped like a self item, a chain run or a queue run. Skips a match that
 *  is part of a longer path or branch segment (`feature/S-...`, `something-S-...`):
 *  a `/` or `-` right before it means the id is stuck to another word, not standing
 *  on its own. */
import { runName } from './runName.js';

const RUN_ID_PATTERNS: RegExp[] = [
  /(?<![/-])\bS-[0-9a-f]{12,}\b(?:-\d+)?/g,
  /(?<![/-])\bjira_([A-Z]{2,6}-\d+)_\d{10,}(?:-\d+)?\b/g,
  // The queue row's whole id, packet suffix included. Matching only the `queue-KEY` head
  // left `-Q-34ddf8a4` standing on the screen beside the ticket key (2026-09-12).
  /(?<![/-])\bqueue-([A-Z]{2,6}-\d+)(?:-Q-[0-9a-f]{6,})?(?:-\d+)?\b/g,
  /(?<![/-])\bqueue-brief-\d{10,}(?:-\d+)?\b/g,
  // A dated brief id: `2026-09-09-forge-compaction-aware-warden`. It reached the board
  // and the Needs-you strip untouched -- the run ids the rest of the board is built to
  // hide were in its own body text all along (2026-09-12). Replaced by the lane's own
  // label, or by the words in the id itself.
  /(?<![/\w-])\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)+\b/g,
  // The intake item's own id, as it appears on a blocker row: `item:Q-fc2090a8`.
  /(?<![/-])\bitem:Q-[0-9a-f]{6,}\b/g,
];

/** A bare hex key at least 16 long that is not a git sha (asks, packets, tokens).
 *  Skips one preceded by `/` or `-`, since that shape is a branch or a path
 *  (`feature/s-b9d39bae548707e0`) and the hex is part of that name, not a
 *  standalone key. */
const HEX_KEY = /(?<![/-])\b[0-9a-f]{16,39}\b/g;
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

/** Runs every match of `pattern` in `text` through `labelFor`, and drops a bare
 *  "run "/"lane " immediately before a match rather than leaving it stuck to the
 *  label that replaces the id ("run S-9c5…" must read "this run", never "run this
 *  run"). Walked by hand instead of `String.replace` because dropping that leading
 *  word means rewriting text before the match starts, which a replacer callback
 *  cannot do on its own. */
function replaceRunIds(text: string, pattern: RegExp, labelFor: (id: string) => string): string {
  let out = '';
  let lastIndex = 0;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const before = text.slice(lastIndex, match.index);
    const leadingWord = /\b(?:run|lane)\s*$/i.exec(before);
    out += (leadingWord ? before.slice(0, leadingWord.index) : before) + labelFor(match[0]);
    lastIndex = match.index + match[0].length;
    match = pattern.exec(text);
  }
  return out + text.slice(lastIndex);
}

/**
 * Replaces every run id in `text` with its label (the ticket key inside it when nothing
 * better is known), drops bare hex keys and journal ids, and shortens shas. Never blanks
 * a sentence: an id that stands alone becomes "this run".
 */
export function stripMachineIds(text: string, options: StripOptions = {}): string {
  let out = text;
  for (const pattern of RUN_ID_PATTERNS) {
    out = replaceRunIds(out, pattern, (id) => options.labelFor?.(id) ?? ticketInId(id) ?? runName(id) ?? 'this run');
  }
  out = shortenShas(out);
  out = out.replace(JOURNAL_ID, '');
  out = out.replace(HEX_KEY, '');
  // A parenthetical that only ever named the run says nothing once the id is gone.
  out = out.replace(/\(\s*(?:this run)?\s*\)/g, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  // A title that began with the run id ("S-...: fix the thing") starts at its real words.
  out = out.replace(/^this run:\s*/i, '');
  return out || 'this run';
}

/** "parking on 19a6c631cb7783d8: Probe: continue?" -> "Asked you: Probe: continue?"
 *  The asked text itself still carries whatever the run wrote into it, so it goes
 *  through `stripMachineIds` too, the same as any other reason. */
/**
 * A park reason written before 2026-09-12 named the measurement rather than saying what
 * happened: "wall clock: 22.3 h over 3.0 h". `session-clock.ts` writes the plain sentence
 * now, but a reason is journaled once and replayed for as long as the lane is on the
 * board, so the two tiles carrying the old wording would have kept it for days. Rewritten
 * at read time, the same way a machine id is.
 */
function plainWallClock(text: string): string {
  // Written without a regex on purpose. The pattern this replaced lost its escapes
  // somewhere between the source and the running function -- the body was right, the
  // match never fired, and the test read green-looking prose over an unchanged string
  // (2026-09-12). Two `indexOf` calls cannot be mangled that way.
  const MARK = 'wall clock:';
  let out = '';
  let rest = text;
  for (;;) {
    const at = rest.toLowerCase().indexOf(MARK);
    if (at === -1) break;
    const after = rest.slice(at + MARK.length);
    const over = after.indexOf(' over ');
    if (over === -1) break;
    const ran = after.slice(0, over).trim();
    const tail = after.slice(over + ' over '.length);
    // The budget runs to the end of the clause: a full stop, a semicolon, or the end.
    const stop = tail.search(/[.;]|$/);
    const expected = tail.slice(0, stop).trim();
    out += `${rest.slice(0, at)}Running ${ran}, expected ${expected}`;
    rest = tail.slice(stop);
  }
  return out + rest;
}

/**
 * Words a run writes about itself that mean nothing to the person reading the board.
 *
 * A park reason is written once by whatever stopped the run and replayed on the tile for
 * as long as the lane is there, so one bad phrase stays on screen for days. The pairs
 * below are the ones seen on the live board; each keeps the meaning and drops the term.
 */
const PLAINER: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdrift confirmed off-brief\b/gi, 'it went off the brief'],
  [/\bconfirmed off-brief\b/gi, 'it went off the brief'],
  [/\bthe transcript tail is\b/gi, 'its log is'],
  [/\btranscript tail\b/gi, 'log'],
  [/\bthe agent\b/gi, 'it'],
  [/\bno actual tool calls or edits shown\b/gi, 'no work recorded'],
];

/** The longest a sentence on a tile may be. A tile is one line beside a state word and a
 *  clock; past this it wraps over the card and buries what it sits next to. */
export const TILE_SENTENCE_LIMIT = 120;

/**
 * One sentence, at most `limit` characters, ending cleanly.
 *
 * A reason arrives as however many sentences whatever stopped the run felt like writing.
 * The board has room for one: a 250-character paragraph on a tile reads as noise, which
 * is the same as reading as nothing (Aaron, 2026-09-13).
 */
export function oneSentence(text: string, limit = TILE_SENTENCE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // A run that ends its own sentence and then meets the template's full stop leaves two.
  const collapsed = flat.replace(/([.!?])[.!?]+/g, '$1');
  const stop = collapsed.search(/[.!?](\s|$)/);
  const first = stop === -1 ? collapsed : collapsed.slice(0, stop + 1);
  if (first.length <= limit) return first.trim();
  const cut = first.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/, '')}…`;
}

export function humanizeParkReason(reason: string): string {
  const asked = /^parking on [0-9a-f]{8,}:\s*(.+)$/is.exec(reason.trim());
  if (asked) return `Asked you: ${oneSentence(stripMachineIds(asked[1]!.trim()))}`;
  let plain = plainWallClock(stripMachineIds(reason));
  for (const [pattern, replacement] of PLAINER) plain = plain.replace(pattern, replacement);
  return oneSentence(plain);
}

/** 24-hour `HH:MM`, zero-padded -- the same shape the browser's own `hm()` in
 *  `src/console/freshness.ts` prints, so a clock time never reads differently
 *  depending on which half of the console rendered it. */
export function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
