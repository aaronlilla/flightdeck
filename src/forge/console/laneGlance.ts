/**
 * The board-at-a-glance fields (2026-09-08, Aaron, verbatim off the live board): `did`
 * (what the agent did), `now` (what it is doing, the same sentence `plain` carries) and
 * `you` (what the operator must do). `did` lives here because it needs the run's own
 * journal rows and PR facts, the same inputs `buildLane` already has in hand; `you` and
 * the sheet's own `next` (`summary.ts`) both read `nextCategoryFor` below, so a tile's
 * one-line ask and the sheet's longer one can never point a person two different ways.
 */
import type { ForgeEvent } from '../journal.js';
import type { Lane, LanePr, NarrationFacts } from '../../shared/console-model.js';
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

/** Where a `did` sentence came from. `report` is the agent's own free text; the other
 *  two are composed here out of the lane's own machine-readable rows. */
export type DidSource = 'report' | 'pr' | 'digest';

/**
 * `did`: one sentence on what the agent did, sourced in order from the newest
 * `forge.report`'s own `done` field, the lane's own PR, a whole-run tool digest, or
 * `null`. Every source passes through `stripMachineIds` and `shortenShas`.
 *
 * The source comes back with the sentence because it decides who is allowed to rewrite
 * it. A `report` sentence is the agent's own account of its work, and the rail already
 * treats it that way -- `forge.report` renders as a `reply`, which is not in
 * `thread-narrate.ts`'s `NARRATED_TYPES`, so the rail shows the agent's words. Without
 * the source the lane tile narrated the same substring, and one report reached the
 * operator in two voices, one of them the model's. `pr` and `digest` are sentences this
 * file composed out of counts and ids, so the narrator may rewrite those.
 */
export function didFrom(
  runEvents: ForgeEvent[], pr: LanePr | null,
): { text: string | null; source: DidSource | null } {
  for (let index = runEvents.length - 1; index >= 0; index -= 1) {
    const row = runEvents[index]!;
    if (row.event === 'forge.report' && typeof row.done === 'string' && row.done.trim()) {
      return { text: clean(firstSentence(row.done)), source: 'report' };
    }
  }
  if (pr) return { text: clean(prDidSentence(pr)), source: 'pr' };
  const digest = toolDigest(runEvents);
  if (digest) return { text: clean(digest), source: 'digest' };
  return { text: null, source: null };
}

/** The sentence alone, for every caller that does not have to decide who may rewrite it. */
export function computeDid(runEvents: ForgeEvent[], pr: LanePr | null): string | null {
  return didFrom(runEvents, pr).text;
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
      // A lane read as blocked only because its process is gone (no registry row in
      // its chain, no journal row for ten minutes) has nothing to reconnect or salvage:
      // it gets the same instruction a parked lane does.
      if (lane.reason === 'its process is gone and it never reported finishing') return 'parked-resume-kill';
      return lane.blockedBy === 'aws' ? 'reconnect-aws' : 'blocked-resume-kill';
    case 'exhausted':
      return 'kill-exhausted';
    case 'unverified':
      return lane.pr ? 'verify-pr' : 'verify-no-pr';
    case 'done':
      // Follow-up to R-61: a PR closed without merging has nothing left to wait
      // on, same as a merged one -- only a genuinely still-open PR reads not-ready.
      return lane.pr && !lane.pr.merged && !lane.pr.closed ? 'not-ready' : 'done-cleanup';
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
      return null;
    case 'merged-cleanup':
      return 'Nothing needed; it merged. Clean up retires it.';
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
      // Not "Kill it": kill refuses an unverified run (nothing is running to kill).
      // Clean up is the exit that actually works for one with no PR.
      return 'Verify it, or Clean up retires it.';
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

/** A state word is only a protected fact when the sentence being narrated is actually
 *  built on it. `Working since 09:15` is a running lane, but demanding the word
 *  `running` back out of the narration would force a sentence no person would write. */
function carriesState(template: string, state: string): boolean {
  return template.toLowerCase().includes(state.toLowerCase());
}

/**
 * The fact record behind `did`. The sentence `computeDid` produced is the template; the
 * facts are the few things the narration is not allowed to lose or invent. The PR number
 * is only a fact when the template actually reports it -- a lane whose `did` came from a
 * tool digest has no business being made to mention a pull request.
 */
export function didFactsFor(lane: Lane, did: string | null): NarrationFacts | null {
  if (!did) return null;
  const facts: Record<string, string | number | boolean | null> = {};
  if (carriesState(did, lane.state)) facts['state'] = lane.state;
  if (lane.ticket) facts['lane'] = lane.ticket;
  const pr = lane.pr;
  if (pr && did.includes(`#${pr.no}`)) {
    facts['pr'] = pr.no;
    if (pr.checks) facts['checks'] = pr.checks;
    if (pr.verdict) facts['verdict'] = pr.verdict;
  }
  return { surface: 'lane.did', facts: facts as NarrationFacts['facts'], template: did };
}

/**
 * The fact record behind `you`. Returns `null` for the one category whose sentence
 * quotes a person -- `answer` carries the operator's own question, which is routed
 * through `Binder.verbatim` and never sent to the model.
 */
export function youFactsFor(lane: Lane, you: string | null): NarrationFacts | null {
  if (!you) return null;
  if (nextCategoryFor(lane, lane.mergeable?.ok === true) === 'answer') return null;
  const facts: Record<string, string | number | boolean | null> = {};
  if (carriesState(you, lane.state)) facts['state'] = lane.state;
  if (lane.ticket) facts['lane'] = lane.ticket;
  if (lane.pr && you.includes(`#${lane.pr.no}`)) facts['pr'] = lane.pr.no;
  return { surface: 'lane.you', facts: facts as NarrationFacts['facts'], template: you };
}

/** always-on-warden R-55: the clock's own plain-English line for the glance ("running
 *  42 min"), off `RunState.startedAt`. `null` for a run the clock has no start time for
 *  (a torn journal, or a row from before the field existed) rather than guessing. */
export function elapsedGlance(startedAt: number | undefined, now: number): string | null {
  if (startedAt === undefined) return null;
  const minutes = Math.max(0, Math.round((now - startedAt) / 60_000));
  if (minutes < 60) return `running ${minutes} min`;
  const hours = minutes / 60;
  return `running ${hours.toFixed(1)} h`;
}
