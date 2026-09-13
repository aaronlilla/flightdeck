/**
 * The one place that turns a contract `Lane` into what a tile shows: glyph,
 * color, label, and the single CTA the HANDOFF names for that state. Kept
 * separate from the components so a test can assert "exactly one CTA per
 * state" without rendering anything.
 */
import type { Blocker, Lane, LaneKind, QueueItem } from '../shared/console-model.js';
import { runName } from '../shared/runName.js';

export interface BoardStateWord {
  word: 'Working' | 'Needs you' | 'Ready to merge' | 'Blocked' | 'Idle';
  color: string;
  border: string;
  borderStyle: 'solid' | 'dashed';
  background: string;
}

/** The design's five state rows (`FD Board.dc.html`, the `S` table): the word, its
 *  colour, and the card's border and ground. */
const STATE_ROW: Record<BoardStateWord['word'], Omit<BoardStateWord, 'word'>> = {
  Working: { color: 'var(--ink3)', border: 'var(--line)', borderStyle: 'solid', background: 'transparent' },
  'Needs you': { color: 'var(--warn)', border: 'var(--warn)', borderStyle: 'solid', background: 'var(--warnTint)' },
  'Ready to merge': { color: 'var(--acc)', border: 'var(--acc)', borderStyle: 'solid', background: 'transparent' },
  Blocked: { color: 'var(--warn)', border: 'var(--line2)', borderStyle: 'solid', background: 'transparent' },
  Idle: { color: 'var(--ink3)', border: 'var(--line2)', borderStyle: 'dashed', background: 'transparent' },
};

function stateRow(word: BoardStateWord['word']): BoardStateWord {
  return { word, ...STATE_ROW[word] };
}

export const IDLE_STATE: BoardStateWord = stateRow('Idle');

/**
 * The Board card's state word. The design has five words for a ten-value `LaneState`,
 * so the rest map onto the closest one. Mergeability outranks state, the same way
 * `boardCta` treats it: a lane with a PR ready to land reads "Ready to merge" whatever
 * its run state says.
 */
export function boardStateWord(lane: Lane): BoardStateWord {
  if (lane.mergeable?.ok && lane.pr && !lane.pr.merged) return stateRow('Ready to merge');
  if (lane.state === 'parked' && lane.question) return stateRow('Needs you');
  if (lane.state === 'running' && lane.runaway) return stateRow('Needs you');
  if (lane.state === 'blocked' || lane.state === 'killed' || lane.state === 'parked' || lane.state === 'paused') return stateRow('Blocked');
  if (lane.state === 'exhausted' || lane.state === 'unverified') return stateRow('Needs you');
  if (lane.state === 'done') {
    return lane.mergeable && lane.mergeable.ok === false ? stateRow('Blocked') : stateRow('Ready to merge');
  }
  return stateRow('Working');
}

/** "14 min", "1 h 12 min", "3 h": the design's elapsed-time form. */
export function durationWords(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The card's time-in-state line, read against the state word: "14 min working",
 *  "9 min waiting", "3 min ready", "41 min blocked", "1 h 12 min parked". */
export function timeInStateText(lane: Lane, now: number, word: BoardStateWord['word']): string {
  const elapsed = durationWords(Math.max(0, now - lane.since));
  const verb = word === 'Needs you' ? 'waiting'
    : word === 'Ready to merge' ? 'ready'
      : word === 'Blocked' ? (lane.state === 'parked' || lane.state === 'paused' ? 'parked' : 'blocked')
        : word === 'Idle' ? 'idle' : 'working';
  return `${elapsed} ${verb}`;
}

/** What the card's one button does. `watch` and `answer` open the lane sheet; the run
 *  actions run their catalog entry; `settings`, `queue` and `blockers` change the view;
 *  `open-pr` and `open-url` open a link; `nudge` asks the Conductor to nudge the owner. */
export type BoardCommand =
  | 'watch' | 'answer' | 'merge' | 'resume' | 'compact' | 'verify' | 'reopen' | 'unretire' | 'kill' | 'recheck'
  // Reachable only from the lane sheet's own action bar: a tile shows one button, chosen
  // by state, so anything the state does not call for had no way to be clicked at all.
  | 'pause' | 'retire' | 'reaudit'
  | 'settings' | 'queue' | 'blockers' | 'open-pr' | 'nudge' | `open-url:${string}`
  // The second press of an irreversible action, carrying the token the first press was
  // answered with. Shaped like `open-url:` above so the board's dispatcher handles it the
  // same way, with no new prop threaded through three components.
  | `confirm:${string}`;

export interface BoardCta {
  label: string;
  cmd: BoardCommand;
  kind: 'primary' | 'warn' | 'secondary';
}

/**
 * Exactly one button per card, per the design's state table: Watch while it works,
 * Answer when it asked, Merge when the PR is ready, and the action that clears a
 * blocked lane (the fix in Settings, the vendor's page, a nudge to the owner). A blocked
 * lane with no blocker on record offers Resume.
 */
export function boardCta(lane: Lane, blocker: Blocker | null = null): BoardCta {
  if (lane.retiredAt !== null) return { label: 'Unretire', cmd: 'unretire', kind: 'secondary' };
  if (lane.state === 'running' && lane.runaway) return { label: 'Kill attempt', cmd: 'kill', kind: 'warn' };
  if (lane.mergeable?.ok && lane.pr && !lane.pr.merged) return { label: 'Merge', cmd: 'merge', kind: 'primary' };
  if (blocker && blocker.state !== 'resolved') {
    if (blocker.kind === 'integration') return { label: 'Fix in Settings', cmd: 'settings', kind: 'warn' };
    if (blocker.kind === 'billing') {
      const link = blocker.links[0];
      return link ? { label: 'Open billing', cmd: `open-url:${link.url}`, kind: 'secondary' } : { label: 'Open blockers', cmd: 'blockers', kind: 'secondary' };
    }
    if (blocker.kind === 'owner' && blocker.who) return { label: `Nudge ${blocker.who}`, cmd: 'nudge', kind: 'secondary' };
    if (blocker.kind === 'question') return { label: 'Answer', cmd: 'answer', kind: 'warn' };
    if (blocker.kind === 'checks') {
      const link = blocker.links[0];
      return link ? { label: 'Open checks', cmd: `open-url:${link.url}`, kind: 'secondary' } : { label: 'Open blockers', cmd: 'blockers', kind: 'secondary' };
    }
  }
  switch (lane.state) {
    case 'running':
    case 'handed-off':
      return { label: 'Watch', cmd: 'watch', kind: 'secondary' };
    case 'parked':
      return lane.question ? { label: 'Answer', cmd: 'answer', kind: 'warn' } : { label: 'Resume', cmd: 'resume', kind: 'primary' };
    case 'paused':
      return { label: 'Resume', cmd: 'resume', kind: 'primary' };
    case 'done':
      return lane.mergeable && lane.mergeable.ok === false
        ? { label: 'Re-check', cmd: 'recheck', kind: 'secondary' }
        : { label: 'Merge', cmd: 'merge', kind: 'primary' };
    case 'blocked':
      return lane.blockedBy ? { label: 'Fix in Settings', cmd: 'settings', kind: 'warn' } : { label: 'Resume', cmd: 'resume', kind: 'primary' };
    case 'exhausted':
      return { label: 'Compact and resume', cmd: 'compact', kind: 'primary' };
    case 'unverified':
      return { label: 'Verify', cmd: 'verify', kind: 'secondary' };
    case 'merged':
      return { label: 'Open PR', cmd: 'open-pr', kind: 'secondary' };
    case 'killed':
      return { label: 'Reopen', cmd: 'reopen', kind: 'secondary' };
    default:
      return { label: 'Watch', cmd: 'watch', kind: 'secondary' };
  }
}

/** The open blocker a lane waits on, if the Blockers view knows one. */
export function blockerFor(lane: Lane, blockers: Blocker[]): Blocker | null {
  return blockers.find((b) => b.state !== 'resolved' && b.blocks.some((x) => x.laneId === lane.id)) ?? null;
}

/** Why an idle slot is idle, from the queue's own state: the sentence under the dashed
 *  card's "Waiting for a Ready ticket". */
export function idleReason(queue: { items: QueueItem[]; paused: boolean; pauseReason: string | null; on: boolean }): string {
  if (!queue.on) return 'Waiting for a Ready ticket; the queue is off, so nothing starts.';
  if (queue.paused) return `Waiting for a Ready ticket; the queue is paused${queue.pauseReason ? ` (${queue.pauseReason})` : ''}.`;
  const queued = queue.items.filter((item) => item.state === 'queued');
  if (queued.length === 0) return 'Waiting for a Ready ticket; nothing is in the queue.';
  const done = queue.items.filter((item) => item.state === 'done');
  const satisfied = (slug: string): boolean => done.some((row) => [row.input, row.ticket, row.branch, row.branch?.replace(/^(feature|hotfix)\//, '')].some((name) => name?.toLowerCase() === slug.toLowerCase()));
  const holding = (item: QueueItem): string[] => (item.after ?? []).filter((slug) => !satisfied(slug));
  const held = queued.filter((item) => holding(item).length > 0);
  if (held.length === queued.length) {
    const first = held[0]!;
    return `Waiting for a Ready ticket; ${first.ticket ?? first.title ?? 'the next item'} waits for ${holding(first).join(', ')}.`;
  }
  return `Waiting for a Ready ticket; ${queued.length} queued, the next starts on the queue's next tick.`;
}

export interface LaneHeadline {
  /** The line every headline renders: the ticket if the lane has one, else the run id. */
  main: string;
  /** The lane's run id. Goes in the `title` attribute, never on its own visible
   *  line, since the prototype's tile headline is one line: `{{l.id}}`. */
  runId: string;
}

/** What a lane's headline says, shared by the tile, the ticket sheet band, and
 *  the needs-you plates: a ticket outranks a title, which outranks the words in the
 *  run's own id, which outranks the fallback "Untitled run". The run id itself never
 *  appears as visible text, only in `runId`, for a `title` attribute (2026-09-08: the
 *  id was still the fallback here, the one machine string the rest of the board was
 *  built to hide).
 *
 *  The id's WORDS are not the id (2026-09-12). Two tiles both read "Untitled run" on
 *  the live board, so there was no telling which `Resume` belonged to which; the words
 *  somebody wrote when they named the work were sitting in the id the whole time, with
 *  only the date stamp and the product's own name around them. `runName` answers null
 *  when an id is a key rather than a name, and the fallback still covers that. */
export function laneHeadline(lane: Lane): LaneHeadline {
  return { main: lane.ticket ?? lane.title ?? runName(lane.id) ?? 'Untitled run', runId: lane.id };
}

/** H2.1: the tile's headline in three parts -- a bold `key` (the ticket), a plain
 *  `title` beside it, and the run's own `runId`, which never renders as text and
 *  goes only in a `title` attribute. A lane with no ticket has no key; a lane the
 *  server has not titled yet has no title. */
export interface TileHeadline {
  key: string | null;
  title: string | null;
  runId: string;
}

export function tileHeadlineParts(lane: Lane): TileHeadline {
  // `title` falls through to the words in the run's own id, for the same reason
  // `laneHeadline` does: two tiles both reading "Untitled run" tell a person nothing
  // about which is which (Aaron, 2026-09-12). The id itself still never renders.
  //
  // A title that only repeats the ticket key is dropped rather than printed twice. The
  // server sets it that way for a ticket it has not read a summary for yet, and the tile
  // came out reading "BBZ-123" over "BBZ-123", which says half as much as it looks like.
  const given = lane.title?.trim();
  const title = given && given !== lane.ticket ? given : runName(lane.id);
  return { key: lane.ticket, title, runId: lane.id };
}

const KIND_LABEL: Record<LaneKind, string> = {
  ticket: 'ticket', hotfix: 'hotfix', brief: 'brief', self: 'self', chain: 'chain', probe: 'probe', manual: 'manual',
};

export function kindLabel(kind: LaneKind): string {
  return KIND_LABEL[kind];
}

/** H2.2: lanes sharing a ticket key fold into one group, newest attempt first --
 *  `Lane.attempts` is the server's own count of how many runs share the ticket;
 *  `lanes` here is whatever subset the caller actually fetched, so a group's own
 *  `lanes.length` (not `attempts`) is what the board can actually show a
 *  disclosure for. A lane with no ticket never groups with anything. */
export interface LaneGroup {
  key: string;
  lanes: Lane[];
}

export function groupLanesByTicket(lanes: Lane[]): LaneGroup[] {
  const groups: LaneGroup[] = [];
  const seen = new Set<string>();
  for (const l of lanes) {
    const key = l.ticket ?? l.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const members = l.ticket ? lanes.filter((m) => m.ticket === l.ticket) : [l];
    members.sort((a, b) => (b.attempt - a.attempt) || (b.startedAt - a.startedAt));
    groups.push({ key, lanes: members });
  }
  return groups;
}
