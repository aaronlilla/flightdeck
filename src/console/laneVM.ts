/**
 * The one place that turns a contract `Lane` into what a tile shows: glyph,
 * color, label, and the single CTA the HANDOFF names for that state. Kept
 * separate from the components so a test can assert "exactly one CTA per
 * state" without rendering anything.
 */
import { ago, hm } from './freshness.js';
import type { Freshness } from './freshness.js';
import type { Blocker, Lane, LaneKind, LanePr, LaneState, Message, QueueItem } from '../shared/console-model.js';
import { fmtTokens } from '../shared/format-tokens.js';
import { shortenShas } from '../shared/humanize.js';

export interface StateGlyph {
  glyph: string;
  color: string;
  label: string;
}

const STATE_GLYPH: Record<LaneState, StateGlyph> = {
  running: { glyph: '●', color: 'var(--run)', label: 'running' },
  'handed-off': { glyph: '▲', color: 'var(--hand)', label: 'handed-off' },
  paused: { glyph: '❙❙', color: 'var(--pause)', label: 'paused' },
  parked: { glyph: '◆', color: 'var(--park)', label: 'parked' },
  done: { glyph: '✓', color: 'var(--run)', label: 'done' },
  merged: { glyph: '⇗', color: 'var(--merge)', label: 'merged' },
  blocked: { glyph: '■', color: 'var(--block)', label: 'blocked' },
  exhausted: { glyph: '◍', color: 'var(--exh)', label: 'exhausted' },
  killed: { glyph: '⌀', color: 'var(--ink3)', label: 'killed' },
  unverified: { glyph: '◌', color: 'var(--ink3)', label: 'unverified' },
};

export function stateOf(state: LaneState): StateGlyph {
  return STATE_GLYPH[state];
}

export interface LaneCta {
  label: string;
  cmd: LaneCommand;
  cls: 'btnP' | 'btnA' | 'btnR' | 'btnS';
}

export type LaneCommand =
  | 'watch' | 'kill' | 'answer' | 'council' | 'resume' | 'merge'
  | 'gate-log' | 'reconnect-aws' | 'compact' | 'verify' | 'open-pr' | 'reopen' | 'unretire';

/**
 * Exactly one CTA per lane state (HANDOFF "Board" section). `runaway` overrides
 * `running`'s CTA, and a `blocked` lane provisioning-blocked on an integration
 * offers reconnect instead of the gate log.
 */
export function laneCta(lane: Lane): LaneCta {
  // H2.2/H2.3: a retired lane's only action is to come back, whatever its own state.
  if (lane.retiredAt !== null) return { label: 'Unretire', cmd: 'unretire', cls: 'btnS' };
  if (lane.state === 'running' && lane.runaway) return { label: 'Kill attempt', cmd: 'kill', cls: 'btnR' };
  // The board's own mergeability verdict outranks the run's state: a PR that is
  // reviewed, green and on the allow-list is ready whether the session behind it ended
  // `done`, `unverified` or `killed` (seen live 2026-09-07: a ready PR under Verify).
  if (lane.mergeable?.ok && lane.pr && !lane.pr.merged) return { label: 'Merge now →', cmd: 'merge', cls: 'btnP' };
  switch (lane.state) {
    case 'running':
      return { label: 'Watch live', cmd: 'watch', cls: 'btnS' };
    case 'parked':
      return lane.question
        ? { label: 'Answer →', cmd: 'answer', cls: 'btnA' }
        : { label: 'Resume ▶', cmd: 'resume', cls: 'btnP' };
    case 'handed-off':
      return { label: 'View council', cmd: 'council', cls: 'btnS' };
    case 'paused':
      return { label: 'Resume ▶', cmd: 'resume', cls: 'btnP' };
    case 'done':
      // H2.1: `mergeable` gates the Merge button -- a lane the board itself knows
      // would refuse (checks red, no verdict yet) offers the gate log instead of a
      // button that only fails when clicked.
      if (lane.mergeable && lane.mergeable.ok === false) return { label: 'Gate log →', cmd: 'gate-log', cls: 'btnS' };
      return { label: 'Merge now →', cmd: 'merge', cls: 'btnP' };
    case 'blocked':
      return lane.blockedBy === 'aws'
        ? { label: 'Reconnect AWS →', cmd: 'reconnect-aws', cls: 'btnA' }
        : { label: 'Gate log →', cmd: 'gate-log', cls: 'btnS' };
    case 'exhausted':
      return { label: 'Compact + resume →', cmd: 'compact', cls: 'btnP' };
    case 'unverified':
      return { label: 'Verify →', cmd: 'verify', cls: 'btnS' };
    case 'merged':
      return { label: 'Open PR ↗', cmd: 'open-pr', cls: 'btnS' };
    case 'killed':
      return { label: 'Reopen', cmd: 'reopen', cls: 'btnS' };
    default:
      return { label: 'Watch live', cmd: 'watch', cls: 'btnS' };
  }
}

/** H2.1: the muted line under a done lane's CTA when Merge would refuse -- null for
 *  every other state, and for a done lane whose `mergeable` is unset or ok. */
export function mergeableWhy(lane: Lane): string | null {
  if (lane.state !== 'done') return null;
  if (!lane.mergeable || lane.mergeable.ok) return null;
  return lane.mergeable.why;
}

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
  | 'settings' | 'queue' | 'blockers' | 'open-pr' | 'nudge' | `open-url:${string}`;

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
  const held = queued.filter((item) => item.after && item.after.length > 0);
  if (held.length === queued.length) {
    const first = held[0]!;
    return `Waiting for a Ready ticket; ${first.ticket ?? first.title ?? 'the next item'} waits for ${first.after!.join(', ')}.`;
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
 *  the needs-you plates: a ticket outranks a title, which outranks the fallback
 *  "Untitled run" -- the run id never appears as visible text, only in `runId`,
 *  for a `title` attribute (2026-09-08: the id was still the fallback here, the
 *  one machine string the rest of the board was built to hide). */
export function laneHeadline(lane: Lane): LaneHeadline {
  return { main: lane.ticket ?? lane.title ?? 'Untitled run', runId: lane.id };
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
  return { key: lane.ticket, title: lane.title, runId: lane.id };
}

const KIND_LABEL: Record<LaneKind, string> = {
  ticket: 'ticket', hotfix: 'hotfix', brief: 'brief', self: 'self', chain: 'chain', probe: 'probe', manual: 'manual',
};

export function kindLabel(kind: LaneKind): string {
  return KIND_LABEL[kind];
}

/** H2.1: the tile's step line -- the server's own one-sentence `plain` once it has
 *  computed one, else the old `step N/M · text` reading, so a lane the fixtures or an
 *  older server never filled `plain` in for still shows something. */
export function plainLine(lane: Lane): string {
  return shortenShas(lane.plain || stepDisplay(lane));
}

/** H2.1: the PR summary line's pieces, split so the number can render as a link and
 *  the rest as plain text: `draft|open · checks <glyph> · council <verdict> ·
 *  N files +A −D`. The council segment is omitted while there is no verdict yet. */
export function prSummaryParts(pr: LanePr): { no: number; url: string; rest: string } {
  // H1.3 fix: `checks` null/absent means the board has never actually read this PR's
  // own state (a queue-sourced lane before its first `/run/:id/pr` fetch), which is a
  // different fact from "pending" (read, and CI is still running) -- the two must never
  // collapse into the same word.
  const checksText = pr.checks === 'success' ? 'checks ✓'
    : pr.checks === 'failure' ? 'checks ✗'
      : pr.checks === 'pending' ? 'checks running'
        : 'checks not read yet';
  const parts = [pr.draft ? 'draft' : 'open', checksText];
  if (pr.verdict) parts.push(`council ${pr.verdict}`);
  // Sweep #17: a merged PR (BBZ-99, live) reported files/add/del all as 0 rather than
  // absent -- printing "0 files +0 -0" as if that were a read diff rather than a stat
  // nobody ever fetched for a PR that is done. `merged` gets its own word instead, and
  // an all-zero reading anywhere else is treated the same as absent: unread, not empty.
  const filesKnown = pr.files !== undefined && pr.add !== undefined && pr.del !== undefined
    && !(pr.files === 0 && pr.add === 0 && pr.del === 0);
  if (pr.merged) {
    parts.push('merged');
  } else if (filesKnown) {
    parts.push(`${pr.files} files +${pr.add} −${pr.del}`);
  }
  return { no: pr.no, url: pr.url, rest: parts.join(' · ') };
}

export function ctxPercent(lane: Lane): number {
  if (lane.ctxCeiling <= 0) return 0;
  return Math.min(100, Math.round((lane.ctxTokens / lane.ctxCeiling) * 100));
}

/** Prefix a tile's step text with `step N/M · ` when the lane has a step total, exactly
 *  as the prototype's `l.stepN?'step '+l.stepN+'/'+l.stepTotal+' · ':''` did. */
export function stepDisplay(lane: Lane): string {
  return lane.stepTotal > 0 ? `step ${lane.stepN}/${lane.stepTotal} · ${lane.stepText}` : lane.stepText;
}

/** The amber line for a lane carrying no cap of its own: a token count past this reads
 *  as "getting expensive" the same way the old `$5` threshold did. Chosen rather than
 *  derived, because there is no single honest exchange rate any more (see
 *  `console-model.ts`'s own note on why token caps carry no dollar default) -- but the
 *  old `$5` threshold, at Sonnet's blended list rate (input $3/M, output $15/M), sat
 *  somewhere between roughly 300k and 1.6M tokens depending on the input/output mix.
 *  1,000,000 is a round number inside that band. */
const EXPENSIVE_TOKENS = 1_000_000;

/** `stale` renders the cost readout phosphor-off (dim, no glow) regardless of amount.
 *  The tile passes `true` for an observed value; other callers (cost sheet, ticket
 *  sheet) never pass it, so their readout still reflects the amount. */
export function costClass(lane: Lane, stale = false): 'w0' | 'w1' | 'w2' | 'ws' {
  if (stale) return 'ws';
  if (lane.tokenCap !== null && lane.tokens > lane.tokenCap) return 'w2';
  if (lane.tokens >= EXPENSIVE_TOKENS) return 'w1';
  return 'w0';
}

/** Matches the prototype's own `'cap $'+l.cap+' · ×'+Math.round(l.cost/l.cap)` in shape:
 *  no word "exceeded", and the multiplier is rounded rather than shown to one decimal --
 *  rendered in tokens, compact, since this fleet has nothing left to price in dollars. */
export function capText(lane: Lane): string {
  if (lane.tokenCap === null) return '';
  if (lane.tokens > lane.tokenCap) {
    const times = Math.round(lane.tokens / lane.tokenCap);
    return `cap ${fmtTokens(lane.tokenCap)} tokens · ×${times}`;
  }
  return `cap ${fmtTokens(lane.tokenCap)} tokens`;
}

/** The tile shows the cap text whenever cost exceeds cap, not only for a lane also
 *  flagged `runaway`: a lane can quietly cross its cap without ever being marked
 *  runaway, and it still needs the warning. */
export function tileCapText(lane: Lane): string {
  return lane.tokenCap !== null && lane.tokens > lane.tokenCap ? capText(lane) : '';
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

/** H2.5: a run of consecutive warden tick events (`source: 'warden'`) collapses into
 *  one chip carrying a count, rather than one tick line per second -- the rail's own
 *  read of H1.9's collapsed narrative. Non-warden messages, and warden messages with
 *  something else between them, are left exactly where they are. */
export function collapseWardenEvents(thread: Message[]): Message[] {
  const out: Message[] = [];
  let run: Message[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const last = run[run.length - 1] as Message;
    out.push(run.length === 1 ? last : { ...last, k: `warden-run-${last.k}`, text: `warden ×${run.length}` });
    run = [];
  };
  for (const m of thread) {
    if (m.type === 'event' && m.source === 'warden') run.push(m);
    else { flush(); out.push(m); }
  }
  flush();
  return out;
}

export interface TipContent {
  head: string;
  body: string;
  click: string;
  color?: string;
}

function whenLabel(fresh: Freshness): string {
  return `${fresh.verified ? 'verified' : 'observed'} ${hm(fresh.at)}`;
}

/** Real hover cards (HANDOFF "Hover cards"): head, then a body carrying the value, its
 *  source and when it was last known, then a "Click → target" line. */
export function costTip(lane: Lane, fresh: Freshness): TipContent {
  const over = lane.tokenCap !== null && lane.tokens > lane.tokenCap;
  return {
    head: `${fmtTokens(lane.tokens)} tokens${over ? ' · over cap' : ''}`,
    body: `value ${fmtTokens(lane.tokens)} tokens · source ${lane.sandbox?.id ?? lane.id} · ${whenLabel(fresh)}`,
    click: 'Click → cost sheet',
    color: over ? '#ff5c47' : '#9df598',
  };
}

export function ctxTip(lane: Lane, fresh: Freshness): TipContent {
  const pct = ctxPercent(lane);
  return {
    head: `${pct}% context`,
    body: `value ${Math.round(lane.ctxTokens / 1000)}k / ${Math.round(lane.ctxCeiling / 1000)}k tokens · source ${lane.id} · ${whenLabel(fresh)}`,
    click: 'Click → ticket sheet',
  };
}

export function modelTip(lane: Lane, fresh: Freshness): TipContent {
  return {
    head: lane.model,
    body: `value ${lane.modelId ?? lane.model} · source ${lane.id} · ${whenLabel(fresh)}`,
    click: 'Click → ticket sheet',
  };
}
