/**
 * The board-at-a-glance fields (2026-09-08, Aaron, verbatim off the live board): `did`
 * (what the agent did), `now` (what it is doing, the same sentence `plain` carries) and
 * `you` (what the operator must do). `did` lives here because it needs the run's own
 * journal rows and PR facts, the same inputs `buildLane` already has in hand; `you` and
 * the sheet's own `next` (`summary.ts`) both read `nextCategoryFor` below, so a tile's
 * one-line ask and the sheet's longer one can never point a person two different ways.
 */
import type { ForgeEvent } from '../journal.js';
import type { Lane, LanePr } from '../../shared/console-model.js';
import { shortenShas, stripMachineIds } from '../../shared/humanize.js';

const DID_LIMIT = 110;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** The first sentence of `text`, or the whole (trimmed) string when it carries no
 *  sentence-ending punctuation. */
function firstSentence(text: string): string {
  const match = /^[^.!?]+[.!?]+/.exec(text.trim());
  return (match ? match[0] : text).trim();
}

function clean(text: string): string {
  return truncate(shortenShas(stripMachineIds(text)), DID_LIMIT);
}

/** Tool name -> [singular, plural] category label, the same digest words
 *  `thread.ts`'s own activity bursts use ("140 commands, 45 file reads"). */
const TOOL_CATEGORY: Record<string, [string, string]> = {
  Bash: ['command', 'commands'],
  Read: ['file read', 'file reads'],
  Edit: ['edit', 'edits'],
  Write: ['edit', 'edits'],
  Grep: ['search', 'searches'],
  Glob: ['search', 'searches'],
  Skill: ['skill', 'skills'],
};

function categoryFor(tool: string): [string, string] {
  return TOOL_CATEGORY[tool] ?? ['other tool call', 'other tool calls'];
}

/** A whole-run tool digest ("Ran 128 commands, 45 file reads, 11 edits"), off every
 *  `tool.start` row the run ever emitted -- `null` for a run with none. */
function toolDigest(runEvents: ForgeEvent[]): string | null {
  const counts = new Map<string, { plural: string; count: number }>();
  for (const row of runEvents) {
    if (row.event !== 'tool.start') continue;
    const tool = typeof row.tool === 'string' ? row.tool : 'unknown';
    const [singular, plural] = categoryFor(tool);
    const existing = counts.get(singular);
    if (existing) existing.count += 1;
    else counts.set(singular, { plural, count: 1 });
  }
  if (counts.size === 0) return null;
  const parts = [...counts.entries()].map(([singular, entry]) => (
    `${entry.count} ${entry.count === 1 ? singular : entry.plural}`
  ));
  return `Ran ${parts.join(', ')}.`;
}

function prDidSentence(pr: LanePr): string {
  const filesKnown = pr.files !== undefined && pr.add !== undefined && pr.del !== undefined;
  const stats = filesKnown ? `, ${pr.files} files +${pr.add} -${pr.del}` : '';
  const label = pr.draft ? 'draft PR' : 'PR';
  const title = pr.title ? `: ${pr.title}` : '';
  return `Opened ${label} #${pr.no}${title}${stats}`;
}

/**
 * `did`: one sentence on what the agent did, sourced in order from the newest
 * `forge.report`'s own `done` field, the lane's own PR, a whole-run tool digest, or
 * `null`. Every source passes through `stripMachineIds` and `shortenShas`.
 */
export function computeDid(runEvents: ForgeEvent[], pr: LanePr | null): string | null {
  for (let index = runEvents.length - 1; index >= 0; index -= 1) {
    const row = runEvents[index]!;
    if (row.event === 'forge.report' && typeof row.done === 'string' && row.done.trim()) {
      return clean(firstSentence(row.done));
    }
  }
  if (pr) return clean(prDidSentence(pr));
  const digest = toolDigest(runEvents);
  if (digest) return clean(digest);
  return null;
}

/**
 * Every category `you` (the tile) and `next` (the ticket sheet's summary block) can
 * land on. Both derive their own text from this one branch table -- `you` off
 * `lane.mergeable` (already cheap on every `/lanes` poll), `next` off the sheet's own
 * fuller `LaneReadiness` -- so the two surfaces can disagree on wording but never on
 * what the operator is actually being asked to do.
 */
export type NextCategory =
  | 'retired' | 'kill-runaway' | 'merge' | 'answer' | 'parked-resume-kill'
  | 'reconnect-aws' | 'blocked-resume-kill' | 'kill-exhausted' | 'verify-pr'
  | 'verify-no-pr' | 'not-ready' | 'done-cleanup' | 'merged-cleanup'
  | 'killed-reopen-cleanup' | 'paused-resume' | 'nothing';

export function nextCategoryFor(lane: Lane, ready: boolean): NextCategory {
  if (lane.retiredAt !== null) return 'retired';
  if (lane.runaway) return 'kill-runaway';
  if (lane.pr && !lane.pr.merged && ready) return 'merge';
  switch (lane.state) {
    case 'parked':
      return lane.question ? 'answer' : 'parked-resume-kill';
    case 'blocked':
      return lane.blockedBy === 'aws' ? 'reconnect-aws' : 'blocked-resume-kill';
    case 'exhausted':
      return 'kill-exhausted';
    case 'unverified':
      return lane.pr ? 'verify-pr' : 'verify-no-pr';
    case 'done':
      return lane.pr && !lane.pr.merged ? 'not-ready' : 'done-cleanup';
    case 'merged':
      return 'merged-cleanup';
    case 'killed':
      return 'killed-reopen-cleanup';
    case 'paused':
      return 'paused-resume';
    case 'running':
    case 'handed-off':
    default:
      return 'nothing';
  }
}

/**
 * `you`: the tile's own one-line ask, or `null` when nothing is needed. `mergeable`
 * (rather than the sheet's fuller readiness) decides the merge override here, since
 * that is the one fact every lane already carries on every `/lanes` poll.
 */
export function computeYou(lane: Lane): string | null {
  const category = nextCategoryFor(lane, lane.mergeable?.ok === true);
  switch (category) {
    case 'retired':
    case 'nothing':
    case 'merged-cleanup':
      return null;
    case 'kill-runaway':
      return 'Kill the attempt.';
    case 'merge':
      return 'Merge it.';
    case 'answer':
      return `Answer: ${truncate(lane.question?.text ?? '', 80)}`;
    case 'parked-resume-kill':
      return 'Read the reason, then Resume or Kill.';
    case 'reconnect-aws':
      return 'Reconnect AWS, then Resume.';
    case 'blocked-resume-kill':
      return 'Resume or Kill it.';
    case 'kill-exhausted':
      return 'Kill and reopen.';
    case 'verify-pr':
      return `Verify it, or read PR #${lane.pr?.no}.`;
    case 'verify-no-pr':
      return 'Verify it, or Kill it.';
    case 'not-ready': {
      const why = lane.mergeable && lane.mergeable.ok === false ? lane.mergeable.why : 'not ready yet';
      return `Not ready: ${why}. Re-check later.`;
    }
    case 'done-cleanup':
      return 'Clean up retires it.';
    case 'killed-reopen-cleanup':
      return 'Reopen or clean up.';
    case 'paused-resume':
      return 'Resume when ready.';
    default:
      return null;
  }
}
