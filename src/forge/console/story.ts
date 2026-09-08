/**
 * `GET /run/:id/story` (H1.6): a lane's whole record, in the order a person would tell
 * it -- what it is, what was done, what was decided and by whom. Every line only
 * appears once its own event has actually happened; a run still mid-flight gets a
 * shorter list than a finished one, never a placeholder for a milestone that has not
 * happened yet.
 *
 * Pure over whatever the caller has already read off disk (the journal, the queue
 * item, the attestation, `git log`) -- this file never opens a file or shells out
 * itself, the same split `journal-narrative.ts` keeps for the ticket sheet's own panel.
 */
import type { ForgeEvent } from '../journal.js';
import type { CouncilAttestation } from '../contracts.js';
import type { LaneKind, LaneStory, LaneStoryEntry, QueueItem } from '../../shared/console-model.js';
import { clock, humanizeParkReason, stripMachineIds } from '../../shared/humanize.js';

export interface GitCommit {
  sha: string;
  subject: string;
  at: number;
}

export interface LaneStoryInput {
  id: string;
  title: string | null;
  kind: LaneKind;
  ticket: { key: string; url: string | null; summary: string | null } | null;
  /** This run's own events plus its successors', in ascending time order. */
  events: ForgeEvent[];
  queueItem?: QueueItem;
  attestation?: CouncilAttestation;
  /** `git log` of the worktree, subjects only, in ascending time order. Absent for a
   *  lane whose worktree no longer exists. */
  gitCommits?: GitCommit[];
  briefPath?: string | null;
  /** The brief file's own text, already read -- this module only ever slices it. */
  briefText?: string | null;
  /** Deliverable 9: `true` keeps every entry exactly as it always read -- a commit's
   *  own sha, a park reason's raw text, and no collapsing of repeats. Default
   *  (unset/false): plain mode -- a commit drops its sha, a park reason reads through
   *  `humanizeParkReason`, every text is free of machine ids, identical consecutive
   *  entries collapse with a repeat count, and a park/resume cycle repeated more than
   *  twice in a row folds into one summary line. */
  verbose?: boolean;
}

const BRIEF_EXCERPT_LIMIT = 600;

/** Item 5: how long an "Asked you: ..." story line runs in plain mode before it is
 *  cut, at a word boundary, with "..." on the end. Verbose keeps the whole thing --
 *  this only trims the plain reading, which otherwise turns a 900-character question
 *  into the entire story line. */
const ASKED_TEXT_LIMIT = 240;

function truncateAskedText(text: string): string {
  if (!text.startsWith('Parked: Asked you:') || text.length <= ASKED_TEXT_LIMIT) return text;
  const cut = text.slice(0, ASKED_TEXT_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const clockTime = clock;

function findAt(events: ForgeEvent[], name: string): ForgeEvent | undefined {
  return events.find((row) => row.event === name);
}

function lastOf(events: ForgeEvent[], name: string): ForgeEvent | undefined {
  let found: ForgeEvent | undefined;
  for (const row of events) if (row.event === name) found = row;
  return found;
}

/** `computeLaneStory`: everything `GET /run/:id/story` returns, folded from what the
 *  caller has already read. Entries are built independently and sorted by `at` at the
 *  end, so ordering here never depends on the order the branches below happen to run in. */
export function computeLaneStory(input: LaneStoryInput): LaneStory {
  const entries: LaneStoryEntry[] = [];
  const { events, queueItem, attestation } = input;

  // A run started by hand, with no ticket, no title and no queue item at all, still
  // gets one line -- the baseline every other branch below builds on top of, never an
  // empty list for a lane that has genuinely started.
  const startedRow = findAt(events, 'run.started');
  if (startedRow && !input.ticket && !input.title) {
    entries.push({ at: startedRow.at, kind: 'start', text: `Started at ${clockTime(startedRow.at)}` });
  }

  if (input.ticket) {
    const queuedAt = queueItem?.createdAt ?? findAt(events, 'intake.planned')?.at ?? events[0]?.at ?? 0;
    entries.push({
      at: queuedAt, kind: 'ticket', url: input.ticket.url,
      text: `Queued from Jira as ${input.ticket.key} at ${clockTime(queuedAt)}`,
    });
  }

  if (input.title) {
    const plannedAt = findAt(events, 'queue.planned')?.at ?? findAt(events, 'intake.planned')?.at
      ?? queueItem?.createdAt ?? events[0]?.at ?? 0;
    entries.push({ at: plannedAt, kind: 'plan', text: `Planned: ${input.title}` });
  }

  if (queueItem?.branch) {
    const launchedAt = findAt(events, 'queue.launched')?.at ?? findAt(events, 'chain.launched')?.at
      ?? queueItem.updatedAt;
    entries.push({
      at: launchedAt, kind: 'branch',
      text: queueItem.base ? `Branch ${queueItem.branch} off ${queueItem.base}` : `Branch ${queueItem.branch}`,
    });
  }

  for (const commit of input.gitCommits ?? []) {
    // Deliverable 9: plain mode drops the sha entirely -- it names nothing a person
    // reads a commit by. Verbose keeps it, since that mode is for someone who already
    // wants the raw record.
    const text = input.verbose ? `Change ${commit.sha.slice(0, 7)}: ${commit.subject}` : `Committed: ${commit.subject}`;
    entries.push({ at: commit.at, kind: 'commit', text });
  }

  if (queueItem?.pr) {
    const reviewedAt = findAt(events, 'queue.review')?.at ?? findAt(events, 'chain.gated')?.at ?? queueItem.updatedAt;
    entries.push({
      at: reviewedAt, kind: 'pr', url: queueItem.pr.url, text: `Draft PR #${queueItem.pr.no} opened`,
    });
  }

  if (attestation) {
    const reviewed = attestation.coverage.total - attestation.coverage.missing.length;
    const noteWord = attestation.decidingFindings.length === 1 ? 'note' : 'notes';
    entries.push({
      at: attestation.at.value, kind: 'council',
      text: `Council: ${attestation.verdict}, ${reviewed} of ${attestation.coverage.total} reviewed, `
        + `${attestation.decidingFindings.length} ${noteWord}`,
    });
    for (const finding of attestation.decidingFindings) {
      entries.push({ at: attestation.at.value, kind: 'council', text: `Council note: ${finding.claim}` });
    }
  }

  const jiraDone = events.find((row) => row.event === 'external.complete' && typeof row.kind === 'string' && row.kind.startsWith('jira-'));
  if (jiraDone) {
    entries.push({ at: jiraDone.at, kind: 'jira', text: 'Jira: moved to In Review/QA, assigned to QA, PR linked' });
  }

  for (const row of events) {
    switch (row.event) {
      case 'run.parked':
      case 'warden.parked':
      case 'governor.parked': {
        const reason = typeof row.reason === 'string' ? row.reason : null;
        // Item 5: whether this is the warden's own park comes from the event name, or
        // from the reason's own opening words -- never from a search anywhere in the
        // reason body, which used to catch a run's own ask text the moment it happened
        // to mention "warden" (a PR describing a warden.health fix, say) and mislabel
        // the whole entry as a warden trip.
        const isWarden = row.event === 'warden.parked' || (reason !== null && /^\s*(warden|script budget|stuck-session)/i.test(reason));
        const text = isWarden
          ? `Warden parked it: ${input.verbose ? (reason ?? 'a health check tripped') : stripMachineIds(reason ?? 'a health check tripped')}`
          : `Parked: ${input.verbose ? (reason ?? 'waiting on you') : humanizeParkReason(reason ?? 'waiting on you')}`;
        entries.push({ at: row.at, kind: 'park', text });
        break;
      }
      case 'ask.answered':
        entries.push({ at: row.at, kind: 'answer', text: `Answered by you: ${String(row.answer ?? '')}` });
        break;
      case 'run.resumed':
        entries.push({ at: row.at, kind: 'resume', text: 'Resumed' });
        break;
      case 'run.killed':
        entries.push({
          at: row.at, kind: 'kill',
          text: `Killed by you: ${typeof row.reason === 'string' ? row.reason : 'no reason recorded'}`,
        });
        break;
      case 'chain.merged':
        entries.push({ at: row.at, kind: 'merge', text: 'Merged' });
        break;
      case 'run.finished':
        entries.push({ at: row.at, kind: 'end', text: `Ended: ${typeof row.verdict === 'string' ? row.verdict : 'unverified'}` });
        break;
      default:
        break;
    }
  }

  if (queueItem?.state === 'done' && !events.some((row) => row.event === 'chain.merged')) {
    const doneAt = lastOf(events, 'queue.review')?.at ?? queueItem.updatedAt;
    entries.push({ at: doneAt, kind: 'merge', text: 'Merged' });
  }

  entries.sort((a, b) => a.at - b.at);

  const finalEntries = input.verbose ? entries : collapseRepeatedText(
    collapseParkResumeCycles(entries.map((entry) => ({ ...entry, text: truncateAskedText(stripMachineIds(entry.text)) }))),
  );

  const brief = input.briefPath && input.briefText
    ? { path: input.briefPath, excerpt: input.briefText.slice(0, BRIEF_EXCERPT_LIMIT) }
    : null;

  return {
    id: input.id, title: input.title, kind: input.kind, ticket: input.ticket, brief, entries: finalEntries,
  };
}

const REPEAT_SUFFIX = / \(x(\d+)\)$/;

function repeatBaseText(text: string): string {
  return text.replace(REPEAT_SUFFIX, '');
}

function repeatCountOf(text: string): number {
  const match = REPEAT_SUFFIX.exec(text);
  return match ? Number(match[1]) : 1;
}

/** Deliverable 9: identical consecutive entries -- the same run parking on the same
 *  reason five ticks running, an answer repeated across a retry -- collapse to one line
 *  with a repeat count, rather than the same sentence read five times over. */
function collapseRepeatedText(entries: LaneStoryEntry[]): LaneStoryEntry[] {
  const result: LaneStoryEntry[] = [];
  for (const entry of entries) {
    const prev = result[result.length - 1];
    if (prev && repeatBaseText(prev.text) === entry.text) {
      const count = repeatCountOf(prev.text) + 1;
      result[result.length - 1] = { ...entry, text: `${entry.text} (x${count})` };
      continue;
    }
    result.push(entry);
  }
  return result;
}

function parkReasonOf(text: string): string {
  return text.replace(/^Parked:\s*/i, '').replace(/^Warden parked it:\s*/i, '');
}

/** Deliverable 9: a park/resume cycle repeated more than twice in a row (the warden
 *  tripping the same stuck-session check over and over) folds into one summary line
 *  rather than a story that is nothing but "Parked" / "Resumed" alternating dozens of
 *  times. Only a run of `park`/`resume` entries longer than two parks collapses; a
 *  single park-then-resume, or two, still reads as its own two lines. */
function collapseParkResumeCycles(entries: LaneStoryEntry[]): LaneStoryEntry[] {
  const result: LaneStoryEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (entry.kind === 'park' || entry.kind === 'resume') {
      let j = i;
      let parkCount = 0;
      let lastParkText = entry.text;
      while (j < entries.length && (entries[j]!.kind === 'park' || entries[j]!.kind === 'resume')) {
        if (entries[j]!.kind === 'park') {
          parkCount += 1;
          lastParkText = entries[j]!.text;
        }
        j += 1;
      }
      if (parkCount > 2) {
        const first = entries[i]!;
        const last = entries[j - 1]!;
        result.push({
          at: last.at, kind: 'park',
          text: `Parked and resumed ${parkCount} times between ${clockTime(first.at)} and ${clockTime(last.at)}; `
            + `last reason: ${parkReasonOf(lastParkText)}`,
        });
        i = j;
        continue;
      }
    }
    result.push(entry);
    i += 1;
  }
  return result;
}
