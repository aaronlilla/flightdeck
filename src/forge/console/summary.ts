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

const MAX_WHAT_SENTENCES = 6;
const MIN_WHAT_SENTENCES = 3;

function ensureSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Strips the story panel's own "Change abc1234: " / "Planned: " / "Queued from Jira
 *  as X at H:MM" labels back to plain prose, so a `what` sentence reads like something
 *  a person wrote about the change, not a quote from the story panel. */
function stripStoryPrefix(text: string): string {
  return text
    .replace(/^Change [0-9a-f]{7,40}:\s*/i, '')
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
    const sentence = ensureSentence(stripStoryPrefix(text));
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
  if (mergeable && mergeable.ok === false) reasons.push(mergeable.why);
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

export function computeLaneSummary(input: LaneSummaryInput): LaneSummary {
  return {
    what: computeWhat(input),
    status: input.lane.plain,
    audit: computeAudit(input.attestation, input.drift),
    readiness: computeReadiness({
      pr: input.pr, attestation: input.attestation,
      mergeable: input.mergeable !== undefined ? input.mergeable : input.lane.mergeable,
      drift: input.drift,
    }),
  };
}
