/**
 * Half A of "a ticket with shipped work still reads Backlog": move the ticket when a
 * pull request opens for it.
 *
 * A ticket read `Backlog`, unassigned, while carrying a draft pull request opened that
 * morning. The queue already assigns and transitions a ticket it drove itself, once the
 * item reaches review. Nothing does it for a pull request opened by hand, which is how
 * that one was opened -- so the board kept offering finished work.
 *
 * This runs off the pull request rather than off any queue state: read the pull request's
 * own title and body, take the ticket key out of it, assign and transition. The ticket key
 * pattern comes from the installed contract, the same one the readability rule uses to
 * require a key in a pull request title, so the two can never disagree about what a key
 * looks like.
 */
import { getReadabilityContractState } from './readability.js';
import type { JiraWriteClient, JiraCallResult } from './jira.js';

export interface PrOpenedEnv {
  /** Who the ticket belongs to while the work is in flight. */
  wipAccountId?: string;
  /** The transition that takes a ticket out of the backlog. */
  wipTransitionId?: string;
}

export interface PrOpenedResult {
  lines: string[];
  /** How many writes the issue tracker refused. A caller exits non-zero on any of them:
   *  a command that reports success while the ticket still reads Backlog reproduces the
   *  defect it exists to stop (review, 2026-09-12). */
  failed: number;
}

export interface PrOpenedEvent {
  event: 'pr-opened.assigned' | 'pr-opened.transitioned' | 'pr-opened.failed' | 'pr-opened.no-key';
  ticket?: string;
  prUrl: string;
  status?: number;
  body?: string;
}

/** Every distinct ticket key in `text`, using the contract's own pattern. Returns an empty
 *  list when no contract is installed -- a missing contract is never a reason to guess at
 *  a key shape. */
export function ticketKeysIn(text: string): string[] {
  const state = getReadabilityContractState();
  if (!state.ok) return [];
  const pattern = new RegExp(state.contract.ticket_key_pattern, 'g');
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) keys.add(match[0]);
  return [...keys];
}

async function perform(
  label: 'pr-opened.assigned' | 'pr-opened.transitioned',
  ticket: string,
  prUrl: string,
  call: () => Promise<JiraCallResult>,
  emit: (event: PrOpenedEvent) => void,
): Promise<string> {
  const result = await call();
  if (result.ok) {
    emit({ event: label, ticket, prUrl, ...(result.status ? { status: result.status } : {}) });
    return `${label}: ${ticket} ok`;
  }
  emit({
    event: 'pr-opened.failed', ticket, prUrl,
    ...(result.status ? { status: result.status } : {}),
    ...(result.body ? { body: result.body } : {}),
  });
  return `${label}: ${ticket} failed (${result.status ?? 'no status'}) ${result.body ?? ''}`.trim();
}

/**
 * Assign and transition every ticket the pull request names. A pull request naming no
 * key changes nothing and says so; one naming two moves both, because both were claimed
 * by it. Each write is independent -- a failure in one never stops the next, and the
 * caller gets a line per attempt.
 */
export async function runPrOpenedHandoff(
  client: JiraWriteClient,
  input: { prUrl: string; title: string },
  env: PrOpenedEnv,
  emit: (event: PrOpenedEvent) => void,
): Promise<PrOpenedResult> {
  // The TITLE only. A body reads "blocked by ACME-100" or "follow-up to ACME-88" all the
  // time, and taking keys from it pulls unrelated tickets out of the backlog and onto
  // somebody's plate (review, 2026-09-12). The title is the ownership claim -- the
  // readability contract already requires exactly one key in it.
  const keys = ticketKeysIn(input.title);
  if (keys.length === 0) {
    emit({ event: 'pr-opened.no-key', prUrl: input.prUrl });
    return { lines: [`${input.prUrl} names no ticket key in its title; nothing to move`], failed: 0 };
  }

  const lines: string[] = [];
  let failed = 0;
  for (const ticket of keys) {
    if (env.wipAccountId) {
      const line = await perform('pr-opened.assigned', ticket, input.prUrl, () => client.assign(ticket, env.wipAccountId!), emit);
      if (line.startsWith('pr-opened.assigned') && line.includes('failed')) failed += 1;
      lines.push(line);
    }
    if (env.wipTransitionId) {
      const line = await perform('pr-opened.transitioned', ticket, input.prUrl, () => client.transition(ticket, env.wipTransitionId!), emit);
      if (line.includes('failed')) failed += 1;
      lines.push(line);
    }
    // The link is what makes the pull request findable from the ticket at all, which is
    // the half of this that the in-flight check reads back. It emits `pr-opened.failed`
    // like the other two: a failure that produces only a line of text and no event left
    // the journal claiming a link that does not exist (review, 2026-09-12).
    const link = await client.link(ticket, input.prUrl);
    if (link.ok) {
      lines.push(`pr-opened.linked: ${ticket} ok`);
    } else {
      failed += 1;
      emit({
        event: 'pr-opened.failed', ticket, prUrl: input.prUrl,
        ...(link.status ? { status: link.status } : {}),
        ...(link.body ? { body: link.body } : {}),
      });
      lines.push(`pr-opened.linked: ${ticket} failed (${link.status ?? 'no status'})`);
    }
  }
  if (!env.wipAccountId && !env.wipTransitionId) {
    lines.push('no assignee or transition configured; the ticket was linked but not moved');
  }
  return { lines, failed };
}
