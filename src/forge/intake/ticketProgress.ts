/**
 * Two stages the spec names that nothing in the pipeline had: the goal audit, and the
 * ticket learning what happened to it.
 *
 * ## The goal audit
 *
 * A gauntlet round on the goal rather than on prose. A critic with fresh context reads
 * the goal next to the ticket that produced it and answers one question: would doing
 * exactly this leave the ticket satisfied? This is the cheapest place in the pipeline to
 * catch a misread ticket, because nothing has been built yet, and it is the stage the
 * 2026-09-18 reply run kept proving necessary: the single most common failure was not bad
 * writing, it was answering a question the ticket did not ask.
 *
 * ## Progress on the ticket
 *
 * A stage that cannot finish used to park in the queue and say nothing on the board, so
 * from Jira the ticket looked untouched. Every ending now reaches the ticket: parked says
 * what it is waiting for, merged says what landed, and a repo we may not merge says so
 * plainly rather than looking stalled.
 *
 * Nothing here writes to Jira or the filesystem itself; the reasoner and the sink are
 * injected, and every comment goes out through the same gates a reply does.
 */

export type GoalAuditVerdict = 'ok' | 'adjust';

export interface GoalAudit {
  verdict: GoalAuditVerdict;
  /** What the goal would fail to deliver, empty when the verdict is ok. */
  gap: string;
  /** The critic's one-sentence reason, for the journal and the inbox. */
  why: string;
}

export interface GoalAuditDeps {
  /** Writes or rewrites the goal. `audit` is absent on the first round. */
  write(input: { round: number; previous?: string; audit?: GoalAudit }): Promise<string>;
  review(input: { round: number; goal: string }): Promise<GoalAudit | null>;
  maxRounds: number;
}

export type GoalAuditOutcome =
  | { ok: true; goal: string; rounds: number }
  | { ok: false; reason: string; bestGoal: string; rounds: number };

/**
 * Loops the goal past its critic. Same shape as the reply gauntlet and for the same
 * reason: the exit is passing, never a round count, and running out of rounds parks for a
 * person rather than building against a goal a critic already said was wrong.
 */
export async function auditGoal(deps: GoalAuditDeps): Promise<GoalAuditOutcome> {
  let previous: string | undefined;
  let lastAudit: GoalAudit | undefined;
  let bestGoal = '';

  for (let round = 1; round <= deps.maxRounds; round += 1) {
    let goal: string;
    try {
      goal = (await deps.write({ round, ...(previous ? { previous } : {}), ...(lastAudit ? { audit: lastAudit } : {}) })).trim();
    } catch (error) {
      return { ok: false, reason: `writing the goal failed on round ${round}: ${msg(error)}`, bestGoal, rounds: round };
    }
    if (!goal) return { ok: false, reason: `the goal came back empty on round ${round}`, bestGoal, rounds: round };
    bestGoal = goal;
    previous = goal;

    let audit: GoalAudit | null;
    try {
      audit = await deps.review({ round, goal });
    } catch (error) {
      return { ok: false, reason: `the goal audit failed on round ${round}: ${msg(error)}`, bestGoal, rounds: round };
    }
    // An unreadable audit is not a pass. Building against an unreviewed goal is the thing
    // this stage exists to prevent.
    if (!audit) return { ok: false, reason: `the goal audit answered in a shape nothing can read, on round ${round}`, bestGoal, rounds: round };
    lastAudit = audit;
    if (audit.verdict === 'ok') return { ok: true, goal, rounds: round };
  }

  return {
    ok: false,
    reason: `the goal did not pass its audit in ${deps.maxRounds} rounds; last gap: ${lastAudit?.gap || 'none named'}`,
    bestGoal,
    rounds: deps.maxRounds,
  };
}

export function goalAuditPrompt(input: { ticket: string; ticketText: string; goal: string }): string {
  return [
    'You are reviewing a goal somebody wrote from a ticket. Be hard on it.',
    '',
    `The ticket, ${input.ticket}:`,
    input.ticketText,
    '',
    'The goal written from it:',
    input.goal,
    '',
    'Answer one question: if somebody did exactly what this goal says, and nothing more,',
    'would the ticket be satisfied? Say adjust when the goal solves a different problem',
    'than the ticket describes, when it misses something the ticket asks for, when it',
    'invents a requirement the ticket never mentions, or when nobody could tell from the',
    'goal whether the work was finished.',
    '',
    'Answer with exactly these three lines and nothing else:',
    'VERDICT: ok | adjust',
    'GAP: <what the goal would fail to deliver, or the word none>',
    'WHY: <one sentence>',
  ].join('\n');
}

export function parseGoalAudit(text: string): GoalAudit | null {
  const verdictRaw = field(text, 'VERDICT');
  if (!verdictRaw) return null;
  const verdict: GoalAuditVerdict | null = /\bok\b/i.test(verdictRaw) ? 'ok'
    : /\badjust\b/i.test(verdictRaw) ? 'adjust' : null;
  if (!verdict) return null;
  const gapRaw = (field(text, 'GAP') ?? '').trim();
  return {
    verdict,
    gap: /^none\b/i.test(gapRaw) ? '' : gapRaw,
    why: (field(text, 'WHY') ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------------------
// Progress on the ticket

export type ProgressStage = 'claimed' | 'planning' | 'building' | 'review' | 'merged' | 'parked' | 'handed-over';

export interface ProgressNote {
  ticket: string;
  stage: ProgressStage;
  /** Why it is where it is. Required for `parked` and `handed-over`: a stall with no
   *  reason on the ticket is the failure this whole stage exists to remove. */
  reason?: string;
  /** The pull request, when there is one. */
  prUrl?: string;
}

/**
 * The comment text for a stage. Deliberately short and in the first person: this is Aaron
 * telling his own ticket where it is, not a status report from a machine. No bold
 * scaffolding, no headings, no sign-off, and never the word automated.
 */
export function progressComment(note: ProgressNote): string | null {
  switch (note.stage) {
    case 'claimed':
      return 'Taking this one.';
    case 'planning':
      return null; // Too noisy to be worth a comment; the board shows it.
    case 'building':
      return null;
    case 'review':
      return note.prUrl ? `PR up for this: ${note.prUrl}` : null;
    case 'merged':
      return note.prUrl ? `Merged, ${note.prUrl}.` : 'Merged.';
    case 'handed-over':
      return note.prUrl
        ? `PR is up at ${note.prUrl} and needs a review before it can land: ${reasonOf(note)}`
        : `Stopping short of the merge on this one: ${reasonOf(note)}`;
    case 'parked':
      return `Parked this for now: ${reasonOf(note)}`;
    default:
      return null;
  }
}

function reasonOf(note: ProgressNote): string {
  const reason = (note.reason ?? '').trim();
  // A parked ticket with no reason is exactly the silence this is here to prevent, so it
  // still says something a person can act on.
  return reason || 'no reason was recorded, which is itself worth a look';
}

export interface ProgressDeps {
  post(ticket: string, body: string): Promise<{ ok: boolean; body?: string; status?: number }>;
  /** The gates a reply passes: length, voice, banned words, humanizer. */
  gate(body: string): string | null;
  /** Stages already reported for a ticket, so a poll loop cannot repeat one. */
  alreadyPosted(ticket: string, stage: ProgressStage): boolean;
  remember(ticket: string, stage: ProgressStage): void;
  journal: { append(row: Record<string, unknown>): void };
}

export type ProgressResult = 'posted' | 'skipped' | 'duplicate' | 'refused';

/** Posts one progress note, once. A refusal is journalled rather than thrown: the work
 *  itself already happened, and losing the comment must not lose the merge. */
export async function postProgress(note: ProgressNote, deps: ProgressDeps): Promise<ProgressResult> {
  const body = progressComment(note);
  if (!body) return 'skipped';
  if (deps.alreadyPosted(note.ticket, note.stage)) return 'duplicate';

  const refusal = deps.gate(body);
  if (refusal) {
    deps.journal.append({ event: 'progress.refused', actor: 'queue', ticket: note.ticket, stage: note.stage, reason: refusal });
    return 'refused';
  }
  // Remembered before the write: a crash between the post and the record must not let a
  // restart comment twice on the same stage.
  deps.remember(note.ticket, note.stage);
  const posted = await deps.post(note.ticket, body);
  if (!posted.ok) {
    deps.journal.append({
      event: 'progress.refused', actor: 'queue', ticket: note.ticket, stage: note.stage,
      reason: posted.body ?? String(posted.status ?? 'no detail'),
    });
    return 'refused';
  }
  deps.journal.append({ event: 'progress.posted', actor: 'queue', ticket: note.ticket, stage: note.stage });
  return 'posted';
}

function field(text: string, label: string): string | null {
  return new RegExp(`^\\s*${label}:\\s*(.*)$`, 'im').exec(text.trim())?.[1] ?? null;
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
