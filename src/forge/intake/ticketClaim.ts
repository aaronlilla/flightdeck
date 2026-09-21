/**
 * The claim decision: for a ticket or a comment the poller found, can FlightDeck take the
 * work, or is a reply the whole of it?
 *
 * This is the piece that makes the two pollers peers. Before it, a ticket assigned to
 * Aaron went through plan, implement, PR and merge, while a comment asking him to do the
 * same piece of work stopped at a reply forever. Now both reach the same decision, and a
 * claim from either source enters `queue.ts` as the same `ticket` item, so there is one
 * pipeline rather than two to keep in step.
 *
 * Three outcomes:
 *
 *  - `claim`: a concrete change in a repo we own, clear enough to plan against, with no
 *    pending decision only Aaron can make. Reply, assign to Aaron, enqueue.
 *  - `answer`: a question whose answer is the whole of it. Reply only.
 *  - `defer`: it needs a person. The drafted reply still goes to the inbox so Aaron sees
 *    the work rather than an empty row.
 *
 * The write order for a claim is fixed and stops at the first failure: comment, assign,
 * enqueue. Commenting first means a failed assign leaves a visible comment rather than a
 * silent reassignment nobody can explain; enqueueing last means the queue never owns a
 * ticket the board does not show as Aaron's.
 */
import type { JiraCallResult } from './jira.js';

export type ClaimAction = 'claim' | 'answer' | 'defer';

export interface ClaimDecision {
  action: ClaimAction;
  /** One sentence, for the journal and the inbox question. */
  why: string;
  /** What to post. A claim and an answer both carry one; a defer's goes to the inbox. */
  reply: string;
  /** Present on a claim: the repo the work lands in, as the intake map names it. */
  repo?: string;
}

export interface ClaimDeps {
  /** Posts the reply. Already gated: `replyRefusal` and the gauntlet ran before this. */
  comment(ticket: string, body: string): Promise<JiraCallResult>;
  /** Assigns the ticket to the operator. */
  assign(ticket: string, accountId: string): Promise<JiraCallResult>;
  /** Adds the ticket to the queue, the same call an assigned ticket makes. */
  enqueue(ticket: string): void;
  operatorAccountId: string;
  journal: { append(row: Record<string, unknown>): void };
  now?: () => number;
}

export type ClaimResult =
  | { ok: true; stage: 'claimed' }
  | { ok: false; stage: 'comment' | 'assign' | 'enqueue'; reason: string };

/**
 * Performs a claim. Never partially reports success: a failure names the stage it stopped
 * at, so the caller can say "commented but could not assign" rather than "failed".
 */
export async function performClaim(
  ticket: string, reply: string, deps: ClaimDeps,
): Promise<ClaimResult> {
  const at = (deps.now ?? Date.now)();

  const posted = await deps.comment(ticket, reply);
  if (!posted.ok) {
    const reason = `the reply was refused: ${posted.body ?? posted.status ?? 'no detail'}`;
    deps.journal.append({ event: 'claim.refused', actor: 'intake', ticket, stage: 'comment', reason, at });
    return { ok: false, stage: 'comment', reason };
  }

  const assigned = await deps.assign(ticket, deps.operatorAccountId);
  if (!assigned.ok) {
    // The comment is already public, which is the point of this order: the ticket shows
    // an answer even though nobody owns it yet, and a person can assign it by hand.
    const reason = `commented, but the assign was refused: ${assigned.body ?? assigned.status ?? 'no detail'}`;
    deps.journal.append({ event: 'claim.refused', actor: 'intake', ticket, stage: 'assign', reason, at });
    return { ok: false, stage: 'assign', reason };
  }

  try {
    deps.enqueue(ticket);
  } catch (error) {
    const reason = `commented and assigned, but the queue refused it: ${error instanceof Error ? error.message : String(error)}`;
    deps.journal.append({ event: 'claim.refused', actor: 'intake', ticket, stage: 'enqueue', reason, at });
    return { ok: false, stage: 'enqueue', reason };
  }

  deps.journal.append({ event: 'claim.taken', actor: 'intake', ticket, at });
  return { ok: true, stage: 'claimed' };
}

// ---------------------------------------------------------------------------------------
// Caps

/**
 * How many tickets one pass may claim, and how many may be claimed in a rolling hour.
 * An uncapped claim loop on a busy board is how this feature becomes thirty lanes nobody
 * asked for, and the machine only has so many workers.
 */
export const CLAIMS_PER_PASS = 2;
export const CLAIMS_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;

export interface ClaimLedgerRow { ticket: string; at: number }

/** Why a claim is not allowed right now, or null when it is. Checked before the model
 *  call, so a capped pass does not spend tokens deciding something it cannot act on. */
export function claimBlocked(
  recent: readonly ClaimLedgerRow[], claimedThisPass: number, now: number,
): string | null {
  if (claimedThisPass >= CLAIMS_PER_PASS) {
    return `already claimed ${claimedThisPass} ticket(s) this pass, the cap is ${CLAIMS_PER_PASS}`;
  }
  const lastHour = recent.filter((row) => row.at >= now - HOUR_MS).length;
  if (lastHour >= CLAIMS_PER_HOUR) {
    return `already claimed ${lastHour} ticket(s) in the last hour, the cap is ${CLAIMS_PER_HOUR}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Deciding

export interface ClaimContext {
  ticket: string;
  summary: string;
  description: string;
  status: string;
  /** The comment that triggered this, when a comment did. Absent for a new assigned ticket. */
  comment?: { author: string; body: string };
  /** The repos the intake map can route to, so the model picks a real one or none. */
  repos: readonly string[];
}

export function claimPrompt(ctx: ClaimContext, operatorName: string): string {
  return [
    `You are ${operatorName}, deciding what to do about a ticket on your team's board.`,
    '',
    `Ticket ${ctx.ticket}: ${ctx.summary}`,
    `Status: ${ctx.status || 'unknown'}`,
    '',
    ctx.description ? `What the ticket says:\n${ctx.description}` : 'The ticket has no description.',
    '',
    ctx.comment ? `${ctx.comment.author} commented:\n${ctx.comment.body}` : '',
    '',
    `The repositories work can land in: ${ctx.repos.join(', ') || 'none configured'}.`,
    '',
    'Pick one action.',
    '- claim: this is a concrete code change in one of those repositories, the ask is',
    '  clear enough to start planning against, and there is no decision only you can make',
    '  still outstanding. Claiming means you answer, take the ticket, and start the work.',
    '- answer: a question, and answering it is the whole job. No code change follows.',
    '- defer: it needs a decision, a priority call, or information nobody has written',
    '  down. Draft the answer anyway so a person can approve it.',
    '',
    'Claim only what you would genuinely start today. A vague ticket, a ticket waiting on',
    'somebody else, and a ticket whose repository is not listed above are all defer.',
    '',
    'Answer with exactly these four lines and nothing else, REPLY last:',
    'ACTION: claim | answer | defer',
    'REPO: <one of the repositories above, or none>',
    'WHY: <one sentence>',
    'REPLY: <what to post on the ticket>',
  ].filter((line) => line !== '').join('\n');
}

/** Reads the four-line decision. Also accepts the same fields as a JSON object. Anything
 *  unreadable is `null`, and the caller treats that as "ask a person". */
export function parseClaim(text: string, repos: readonly string[]): ClaimDecision | null {
  const trimmed = text.trim();
  const json = tryJson(trimmed);

  const actionRaw = (json ? str(json['action']) : line(trimmed, 'ACTION')) ?? '';
  const action = /\bclaim\b/i.test(actionRaw) ? 'claim'
    : /\banswer\b/i.test(actionRaw) ? 'answer'
      : /\bdefer\b/i.test(actionRaw) ? 'defer' : null;
  if (!action) return null;

  const why = ((json ? str(json['why']) : line(trimmed, 'WHY')) ?? '').trim();
  const reply = ((json ? str(json['reply']) : replyBlock(trimmed)) ?? '').trim();
  const repoRaw = ((json ? str(json['repo']) : line(trimmed, 'REPO')) ?? '').trim();
  const repo = repos.find((r) => r.toLowerCase() === repoRaw.toLowerCase());

  // A claim naming no repo we own is not a claim: the queue would have nowhere to put it.
  // Downgrading to defer keeps the drafted reply and puts a person in the loop. The reason
  // says the routing failed, because the model's own reason explains why it wanted to
  // claim and would read as a defer nobody can account for.
  if (action === 'claim' && !repo) {
    const named = repoRaw && !/^none$/i.test(repoRaw) ? `"${repoRaw}"` : 'no repo';
    return {
      action: 'defer',
      why: `wanted to claim it but named ${named}, which is not a repository work can land in`,
      reply,
    };
  }

  return { action, why, reply, ...(repo ? { repo } : {}) };
}

function line(text: string, label: string): string | null {
  return new RegExp(`^\\s*${label}:\\s*(.*)$`, 'im').exec(text)?.[1] ?? null;
}

/** REPLY is last and may run to several lines, so it takes everything after the label. */
function replyBlock(text: string): string | null {
  return /^\s*REPLY:[ \t]*([\s\S]*)$/im.exec(text)?.[1] ?? null;
}

function str(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function tryJson(text: string): Record<string, unknown> | null {
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
