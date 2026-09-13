/**
 * `plain` (H1.2): one sentence a person can act on for every lane state -- the field
 * the board's own screenshot specimen (2026-09-07) had nothing for, so a tile read as a
 * run id, a queue key and a bare verdict word with no way to tell what to do next.
 *
 * Never a run id, a hop number or a bare verdict word on its own: every branch below
 * either names a person-facing fact (a PR number, a model's own name, a turn count, a
 * clock time) or a full clause a person can act on.
 */
import type { Lane, NarrationFacts, QueueItem } from '../../shared/console-model.js';
import { clock, humanizeParkReason } from '../../shared/humanize.js';

export interface PlainContext {
  now: number;
}

const MODEL_NAMES: Record<string, string> = {
  'sonnet-5': 'Sonnet', 'opus-5': 'Opus', 'haiku-4.5': 'Haiku',
};

/** The model alias's own display name (`sonnet-5` -> `Sonnet`), shared with the plain
 *  run thread's own "Started on <Model name>" line. */
export function modelName(model: string): string {
  return MODEL_NAMES[model] ?? model;
}

const clockTime = clock;

function dayLabel(at: number, now: number): string {
  const days = Math.floor((now - at) / (24 * 60 * 60_000));
  if (days <= 0) return 'today';
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Item 1: the one sentence a merged PR gets, whatever state it outranked to get
 *  there -- `Merged: PR #39 landed at HH:MM.`, or without the clock clause when the
 *  PR's own `mergedAt` was never read. */
export function prMergedSentence(pr: Lane['pr']): string {
  if (!pr) return 'Merged.';
  const time = pr.mergedAt ? ` at ${clockTime(pr.mergedAt)}` : '';
  return `Merged: PR #${pr.no} landed${time}.`;
}

/** Follow-up to R-61 (live finding, PR #80): a PR closed without merging is not
 *  "open" -- the board read "PR #80 is open; the council reviews it next" for three
 *  days after the PR actually closed. `null` for a PR the caller hasn't asked about,
 *  so every call site's own "no PR" branch stays untouched. */
function closedPrSentence(pr: Lane['pr']): string | null {
  if (!pr?.closed) return null;
  return `PR #${pr.no} was closed without merging.`;
}

/** One full stop at the end, whether or not the text brought its own. */
function endOnce(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function reviewSentence(lane: Lane): string | null {
  const pr = lane.pr;
  if (!pr) return null;
  if (pr.merged) return null;
  const closed = closedPrSentence(pr);
  if (closed) return closed;
  const checks = pr.checks === 'success' ? 'checks green'
    : pr.checks === 'failure' ? 'checks red'
      : 'checks pending';
  const verdict = pr.verdict ? `the council's ${pr.verdict}` : 'no council verdict yet';
  return `Draft PR #${pr.no} is open with ${checks} and ${verdict}; waiting for your Merge.`;
}

/** `plainStatus`: the one sentence `GET /lanes` carries for every lane, whatever its
 *  state -- computed here rather than left to a UI that would otherwise have to decode
 *  a state enum and a hop number itself. */
export function plainStatus(lane: Lane, context: PlainContext): string {
  switch (lane.state) {
    case 'running':
    case 'handed-off': {
      const model = modelName(lane.model);
      // The step text can carry a successor's run id ("S-…-3 running Bash"); keep only
      // the tool or verb after the last id-shaped token.
      const step = lane.stepText.replace(/[A-Za-z0-9_-]*[0-9a-f]{8,}[A-Za-z0-9_-]*\s*/g, '').replace(/^\s*(running|resumed)\s+/i, '').trim();
      const last = step ? `, last did: ${step}` : '';
      return `Working since ${clockTime(lane.since)} on a ${model} session, ${lane.stepN} turns in${last}.`;
    }
    case 'paused':
      return `Paused at ${clockTime(lane.since)}. Resume to continue.`;
    case 'parked': {
      if (lane.question) {
        if (lane.question.text.trim() === '') {
          return 'Asked with no question; dismiss or resume';
        }
        return `Asking: ${truncate(lane.question.text, 90)}`;
      }
      if (lane.reason && /warden|script budget|stuck-session/i.test(lane.reason)) {
        return `Parked by the warden at ${clockTime(lane.since)}: ${lane.reason}. Resume to continue.`;
      }
      if (lane.reason) {
        return `Parked at ${clockTime(lane.since)}: ${lane.reason}. Resume to continue.`;
      }
      return `Parked at ${clockTime(lane.since)}, waiting on you. Resume to continue.`;
    }
    case 'done':
    case 'exhausted': {
      const review = reviewSentence(lane);
      if (review) return review;
      if (lane.kind === 'probe') return `Probe passed at ${clockTime(lane.since)}.`;
      if (lane.pr) {
        return `The session ended without finishing its checklist, but its PR #${lane.pr.no} is open; `
          + 'the council reviews it next.';
      }
      return `Finished at ${clockTime(lane.since)} with no pull request open.`;
    }
    case 'unverified': {
      const closed = closedPrSentence(lane.pr);
      if (closed) return `The session ended without finishing its checklist. ${closed}`;
      if (lane.pr) {
        return `The session ended without finishing its checklist, but its PR #${lane.pr.no} is open; `
          + 'the council reviews it next.';
      }
      return `The session ended without finishing its checklist, and it opened no pull request.`;
    }
    case 'merged': {
      const time = `Merged into develop at ${clockTime(lane.since)}`;
      return `${time}; dev OTA not yet checked.`;
    }
    case 'blocked': {
      const day = dayLabel(lane.since, context.now);
      // Through the same read-time humanizer the rail uses, so a reason journaled before
      // the wording changed reads in plain words here too. The two tiles carrying
      // "wall clock: 22.3 h over 3.0 h" kept it for three days otherwise, because a
      // reason is written once and replayed for as long as the lane is on the board
      // (Aaron, 2026-09-12: no jargon in anything on screen).
      const reason = lane.reason ? humanizeParkReason(lane.reason) : 'the reason has not been recorded';
      const prefix = lane.kind === 'chain' ? 'Blocked since' : 'Stuck since';
      // The reason may end its own sentence. Adding a second full stop on top is how the
      // board came to carry "... verification steps.." (Aaron, 2026-09-13).
      return `${prefix} ${day}: ${endOnce(reason)}`;
    }
    case 'killed': {
      const reason = lane.reason ? ` (${lane.reason})` : '';
      return `Stopped by you at ${clockTime(lane.since)}${reason}.`;
    }
    default:
      return `${lane.state}.`;
  }
}

/** The council coverage a `plain` sentence needs -- the same two figures
 *  `computeLaneStory` already reads off a `CouncilAttestation` (`attestation.verdict`,
 *  `attestation.coverage.total - attestation.coverage.missing.length`), passed in
 *  already-resolved rather than as the whole attestation shape, so this module never
 *  needs to import the council's own types. */
export interface QueueVerdict {
  verdict: string;
  reviewed: number;
  total: number;
}

/**
 * `plainForQueueItem` (H1.2 fix, 2026-09-07): the board's `plain` line for a lane the
 * intake queue owns must say what the queue actually knows, not what the run's own
 * verdict happens to read -- a run can finish `unverified` while its queue item is
 * three states further along in `review`, and the run-based sentence above has no way
 * to hear that. Only the four states below override the run-based sentence at all:
 * every other queue state (`queued`, `planning`, `running`, `failed`) tracks the lane's
 * own run state closely enough that `plainStatus` already reads right for it.
 *
 * Never a run id, a successor id, or a hop word -- every branch here names a PR number,
 * a council verdict word, a coverage count or the item's own reason, in a full sentence
 * a person can act on.
 */
/**
 * What has already happened to a pull request, when something has.
 *
 * Merged and closed are facts about the past, and they outrank every sentence about what
 * to do next. Kept in one place so a branch added later cannot forget one of them: the
 * defect this exists for was a `review` branch that checked neither.
 */
function settledPrSentence(pr: NonNullable<QueueItem['pr']>): string | null {
  if (pr.merged) return `Merged: draft PR #${pr.no} landed.`;
  if (pr.closed) return `PR #${pr.no} was closed without merging.`;
  return null;
}

export function plainForQueueItem(item: QueueItem, verdict: QueueVerdict | null, owner: string | null = null): string | null {
  // Before anything else: what has already happened to this pull request outranks what
  // the item's own state says is next. A `review` row whose pull request closed or merged
  // underneath it asked for a merge that could never happen -- the board read "Draft PR
  // 206 waiting for your merge" beside its own verdict of "closed without merging"
  // (Aaron, 2026-09-13). `done` already read this way; `review` did not, and a row sits in
  // `review` for exactly as long as somebody has not merged it, which is the whole window
  // in which it can close.
  const settled = item.pr ? settledPrSentence(item.pr) : null;
  if (settled) return settled;
  switch (item.state) {
    case 'review': {
      const pr = item.pr;
      if (!pr) return null;
      const verdictClause = verdict
        ? `council ${verdict.verdict}, ${verdict.reviewed} of ${verdict.total} reviewed`
        : 'the council has not posted a verdict yet';
      const checksClause = pr.checks === 'success' ? ', checks green'
        : pr.checks === 'failure' ? ', checks red'
          : pr.checks === 'pending' ? ', checks pending'
            : '';
      // A repo the queue may not merge (controlled code) waits on its owner, not on a click.
      const waits = owner ? `draft PR #${pr.no} waits for ${owner} to land it` : `draft PR #${pr.no} is waiting for your Merge`;
      return `In review: ${verdictClause}${checksClause}; ${waits}.`;
    }
    case 'done': {
      const pr = item.pr;
      if (!pr) return null;
      // Merged and closed are both answered by `settledPrSentence` above.
      return `Draft PR #${pr.no} is open; the queue never merges on its own, so it is waiting for your Merge.`;
    }
    case 'parked':
      return item.reason ? `Parked: ${item.reason}.` : 'Parked, waiting on you.';
    default:
      return null;
  }
}

/**
 * The fact record behind `now`.
 *
 * Two things are deliberately absent from the narrated sentence for a running lane: the
 * turn count and the step text. Both tick on every poll, and a cache keyed on either
 * would buy a fresh model call for every lane every few seconds while saying nothing new.
 * They are already their own fields (`stepN`, `stepTotal`, `stepText`) and the verbose
 * register keeps them verbatim, so nothing is hidden -- the narrated sentence just stops
 * re-stating a number the tile is already showing.
 *
 * `null` means "do not narrate this one": a parked lane quoting the operator's own
 * question is person-authored text, and the route passes it through untouched.
 */
export function plainFactsFor(lane: Lane, plain: string | null, context: PlainContext): NarrationFacts | null {
  if (!plain) return null;
  if (lane.question && (lane.state === 'parked' || lane.state === 'blocked')) return null;
  const facts: Record<string, string | number | boolean | null> = {};
  if (lane.ticket) facts['lane'] = lane.ticket;
  if (lane.pr && plain.includes(`#${lane.pr.no}`)) facts['pr'] = lane.pr.no;

  if (lane.state === 'running' || lane.state === 'handed-off') {
    const model = modelName(lane.model);
    facts['model'] = model;
    facts['started'] = clockTime(lane.since);
    return {
      surface: 'lane.now',
      facts: facts as NarrationFacts['facts'],
      template: `Working since ${clockTime(lane.since)} on a ${model} session.`,
    };
  }
  if (plain.toLowerCase().includes(lane.state.toLowerCase())) facts['state'] = lane.state;
  void context;
  return { surface: 'lane.now', facts: facts as NarrationFacts['facts'], template: plain };
}
