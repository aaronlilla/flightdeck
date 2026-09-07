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
}

const BRIEF_EXCERPT_LIMIT = 600;

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

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
    entries.push({ at: commit.at, kind: 'commit', text: `Change ${commit.sha.slice(0, 7)}: ${commit.subject}` });
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
        const isWarden = row.event === 'warden.parked' || (reason && /warden|script budget|stuck-session/i.test(reason));
        entries.push({
          at: row.at, kind: 'park',
          text: isWarden ? `Warden parked it: ${reason ?? 'a health check tripped'}` : `Parked: ${reason ?? 'waiting on you'}`,
        });
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

  const brief = input.briefPath && input.briefText
    ? { path: input.briefPath, excerpt: input.briefText.slice(0, BRIEF_EXCERPT_LIMIT) }
    : null;

  return {
    id: input.id, title: input.title, kind: input.kind, ticket: input.ticket, brief, entries,
  };
}
