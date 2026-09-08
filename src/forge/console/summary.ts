/**
 * `computeLaneSummary` (2026-09-07): the ticket sheet's own summary block, read before
 * anything else on the sheet. What was done, the lane's own `plain` status, whether it
 * was audited, and whether it is proven ready to merge.
 *
 * Pure over facts the caller has already read (a PR's own title/body off `gh`, the
 * lane's own story, the council's attestation, and git's own drift facts) -- this
 * module never opens a file or shells out itself, the same split `story.ts` and
 * `plain.ts` already keep for the rest of the ticket sheet.
 */
import type {
  Lane, LaneAudit, LaneReadiness, LaneStory, LaneSummary,
} from '../../shared/console-model.js';
import type { CouncilAttestation } from '../contracts.js';
import { nextCategoryFor } from './laneGlance.js';
import { stripMachineIds } from '../../shared/humanize.js';

const MAX_WHAT_SENTENCES = 6;
const MIN_WHAT_SENTENCES = 3;

function ensureSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Strips the story panel's own "Change abc1234: " / "Committed: " / "Planned: " /
 *  "Queued from Jira as X at H:MM" labels back to plain prose, so a `what` sentence
 *  reads like something a person wrote about the change, not a quote from the story
 *  panel. */
function stripStoryPrefix(text: string): string {
  return text
    .replace(/^Change [0-9a-f]{7,40}:\s*/i, '')
    .replace(/^Committed:\s*/i, '')
    .replace(/^Planned:\s*/i, '');
}

export interface PrFacts {
  title: string | null;
  body: string | null;
  checks: 'success' | 'failure' | 'pending' | null;
  merged: boolean | null;
}

export interface DriftFacts {
  /** Commits `origin/<base>` has gained since the PR's own merge-base, or `null` when
   *  the drift check could not run (no checkout configured for the repo, a fetch that
   *  failed). Never a guessed 0. */
  behindBase: number | null;
  /** Whether the PR's own head sha has moved past the sha the attestation reviewed. */
  headMoved: boolean;
  /** The PR's own commit subjects, newest first, six at most -- never the story
   *  panel's whole-worktree, oldest-first commit list. */
  commits?: string[];
}

export interface LaneSummaryInput {
  lane: Lane;
  story: LaneStory | null;
  pr: PrFacts | null;
  attestation: CouncilAttestation | null;
  drift: DriftFacts;
  /** Whether the queue's own rules would let a Merge click land, off the same fresh
   *  `pr`/`attestation` this summary reads -- never `lane.mergeable`, which can still be
   *  carrying whatever the last board poll's cached PR snapshot said. Absent (`undefined`)
   *  falls back to `lane.mergeable` for a caller that has not computed a fresh one. */
  mergeable?: Lane['mergeable'];
}

/** Reduces a PR body to prose for the summary block: fenced code blocks (the typed
 *  handoff JSON travels in one of these) are dropped whole, then markdown headings and
 *  list markers are dropped line by line, and the first two sentences of the first
 *  remaining paragraph are kept. `null` when nothing prose-shaped survives. */
function bodyToProse(body: string): string | null {
  const withoutFences = body.replace(/```[\s\S]*?```/g, '');
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const rawLine of withoutFences.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current.length > 0) { paragraphs.push(current.join(' ')); current = []; }
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^([-*+]|\d+\.)\s/.test(line)) continue;
    current.push(line);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));

  const firstProse = paragraphs.find((p) => p.trim().length > 0);
  if (!firstProse) return null;
  const sentences = firstProse.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
  const kept = sentences ? sentences.slice(0, 2).join(' ') : firstProse;
  return kept.replace(/\s+/g, ' ').trim();
}

/** "What was done": three to six sentences, drawn from the PR's own title, the first
 *  paragraph of its body reduced to prose, and the PR's own commits off `drift.commits`
 *  (`git log` against the PR's own merge-base, never the story panel's whole-worktree
 *  commit list) -- falling back to the story's plan and ticket lines only when those
 *  alone come up short. Never padded: a lane with a single real fact on record gets a
 *  single sentence, not several invented ones stretched to reach a target count. */
export function computeWhat(input: Pick<LaneSummaryInput, 'story' | 'pr' | 'drift'>): string[] {
  const { story, pr, drift } = input;
  const sentences: string[] = [];
  const seen = new Set<string>();
  const push = (text: string | null | undefined): void => {
    if (!text) return;
    // Item 3: "what happened" line 1 read `S-b9d39bae548707e0: dedupe warden.health on
    // an open unregistered trip.` on the live board -- a PR title carried the run id
    // straight through. Every sentence here goes through the same `stripMachineIds`
    // every other panel on the sheet already runs its own text through.
    const sentence = stripMachineIds(ensureSentence(stripStoryPrefix(text)));
    if (!sentence || seen.has(sentence)) return;
    seen.add(sentence);
    sentences.push(sentence);
  };

  push(pr?.title ?? null);
  if (pr?.body) push(bodyToProse(pr.body));
  for (const subject of drift.commits ?? []) {
    if (sentences.length >= MAX_WHAT_SENTENCES) break;
    push(subject);
  }
  // Item 9: with no PR at all, `drift.commits` never gets populated -- it only ever
  // reads a PR's own commit range -- so "what happened" had nothing but the plan
  // line. The story panel's own `commit` entries are the run's own commits too (they
  // are range-scoped the same way, per the 2026-09-08 story-scoping fix), so they
  // stand in here, newest first and six at most, ahead of the plan/ticket fallback.
  if (!pr) {
    const commits = (story?.entries ?? []).filter((entry) => entry.kind === 'commit');
    for (let i = commits.length - 1; i >= 0 && sentences.length < MAX_WHAT_SENTENCES; i -= 1) {
      push(commits[i]!.text);
    }
  }
  if (sentences.length < MIN_WHAT_SENTENCES) {
    for (const entry of story?.entries ?? []) {
      if (sentences.length >= MAX_WHAT_SENTENCES) break;
      if (entry.kind === 'plan' || entry.kind === 'ticket') push(entry.text);
    }
  }
  return sentences.slice(0, MAX_WHAT_SENTENCES);
}

/** Whether it was audited: the council's own verdict off the attestation the gate
 *  wrote, or `null` when no council round has ever landed for this PR. `stale` (and
 *  `staleWhy`) come straight off `drift.headMoved` -- the same fact `computeReadiness`
 *  reads, so the audit line and the readiness line can never disagree about it. */
export function computeAudit(attestation: CouncilAttestation | null, drift: DriftFacts): LaneAudit | null {
  if (!attestation) return null;
  const reviewed = attestation.coverage.total - attestation.coverage.missing.length;
  return {
    verdict: attestation.verdict,
    reviewed,
    total: attestation.coverage.total,
    at: attestation.at.value,
    head: attestation.head,
    findings: attestation.decidingFindings.length,
    findingsText: attestation.decidingFindings.map((f) => `${f.member}: ${f.claim}`),
    stale: drift.headMoved,
    staleWhy: drift.headMoved ? 'the PR head has moved since this audit ran' : null,
  };
}

const CLEARED_VERDICTS = new Set(['PASS', 'PASS WITH NOTES']);

/** Whether it is proven ready to merge: checks, the council's verdict, the queue's own
 *  merge allow-list (`lane.mergeable`), and drift. `ok` is true only when every one of
 *  those actually cleared; a lane whose checks are green and whose council passed but
 *  whose head has since moved past its own audit is not ready, and `why` says so. */
export function computeReadiness(input: {
  pr: PrFacts | null;
  attestation: CouncilAttestation | null;
  mergeable: Lane['mergeable'];
  drift: DriftFacts;
}): LaneReadiness {
  const {
    pr, attestation, mergeable, drift,
  } = input;
  // Item 1: a merged PR is done -- checks and the audit no longer decide anything, and
  // saying "checks are failure; not audited yet; already merged" (all three true, only
  // one of them the reason) was never the readable clause the merged-lane sentence
  // needs. `already merged` is the whole story.
  if (pr?.merged) {
    return {
      ok: false, why: 'already merged', checks: pr.checks ?? null, behindBase: null, headMoved: false,
    };
  }
  const reasons: string[] = [];
  if (!pr) {
    reasons.push('no PR is open yet');
  } else if (pr.checks !== 'success') {
    reasons.push(`checks are ${pr.checks ?? 'not read yet'}`);
  }
  if (!attestation) {
    reasons.push('not audited yet');
  } else if (!CLEARED_VERDICTS.has(attestation.verdict)) {
    reasons.push(`council verdict is ${attestation.verdict}`);
  }
  // Item 9: with no PR at all, `mergeable.why` is always some form of "no PR yet" --
  // the exact thing the `!pr` clause above already said. Skip it there, or "Not
  // ready" says the same fact twice ("no PR is open yet; not audited yet; no PR yet").
  if (pr && mergeable && mergeable.ok === false) reasons.push(mergeable.why);
  if (drift.headMoved) reasons.push('the PR head moved since the audit');
  if (drift.behindBase) {
    reasons.push(`the base branch gained ${drift.behindBase} commit${drift.behindBase === 1 ? '' : 's'} since`);
  }
  return {
    ok: reasons.length === 0,
    why: reasons.length ? reasons.join('; ') : null,
    checks: pr?.checks ?? null,
    behindBase: drift.behindBase,
    headMoved: drift.headMoved,
  };
}

/**
 * The one thing to do next, from the lane's state and the readiness verdict. Every
 * branch is an instruction a person can follow from the sheet they are looking at, or
 * a plain "nothing needed" when the run is working. Never a state word on its own.
 *
 * Reads the same `nextCategoryFor` branch table the tile's own `you` field
 * (`laneGlance.ts`) reads, keyed here off the sheet's fuller `LaneReadiness` rather
 * than the tile's cheaper `lane.mergeable` -- so the sheet's longer sentence can never
 * point a person a different direction than the tile's shorter one did.
 */
export function computeNext(lane: Lane, readiness: LaneReadiness | null): string {
  const category = nextCategoryFor(lane, readiness?.ok === true);
  switch (category) {
    case 'retired':
      return 'Nothing needed; this lane is archived. Unretire it to bring it back.';
    case 'kill-runaway':
      return 'It is over its cap and looping. Kill the attempt, then reopen with a tighter brief.';
    case 'merge':
      return 'Merge it. Checks are green and the council passed.';
    case 'nothing':
      return 'Nothing needed; let it work. Watch live if you want to see each step.';
    case 'paused-resume':
      return 'Resume it when you are ready.';
    case 'answer':
      return 'Answer the question below; the run continues as soon as you do.';
    case 'parked-resume-kill':
      return 'Read the reason, then Resume it or Kill it.';
    case 'reconnect-aws':
      return 'Reconnect AWS, then Resume it.';
    case 'blocked-resume-kill':
      return 'Read the reason. If the work is salvageable, Resume it; otherwise Kill it and reopen.';
    case 'kill-exhausted':
      return 'It ran out of context. Kill it and reopen; the next attempt starts from its PR if one exists.';
    case 'verify-pr':
      return `Verify it, or read PR #${lane.pr!.no} yourself before deciding.`;
    case 'verify-no-pr':
      return 'Verify it, or Clean up retires it if the session left nothing worth keeping.';
    case 'not-ready':
      return readiness?.why ? `Not ready to merge yet: ${readiness.why}. Re-check once that clears.` : 'Merge it.';
    case 'done-cleanup':
      return lane.pr?.merged ? 'Nothing needed; it merged. Clean up retires it.' : 'Nothing to merge. Clean up retires it.';
    case 'merged-cleanup':
      return 'Nothing needed; it merged. Clean up retires it.';
    case 'killed-reopen-cleanup':
      return 'Reopen it to try again, or Clean up to retire it.';
    default:
      return 'Read the story below.';
  }
}

export function computeLaneSummary(input: LaneSummaryInput): LaneSummary {
  const readiness = computeReadiness({
    pr: input.pr, attestation: input.attestation,
    mergeable: input.mergeable !== undefined ? input.mergeable : input.lane.mergeable,
    drift: input.drift,
  });
  return {
    what: computeWhat(input),
    status: input.lane.plain,
    next: computeNext(input.lane, readiness),
    audit: computeAudit(input.attestation, input.drift),
    readiness,
  };
}
