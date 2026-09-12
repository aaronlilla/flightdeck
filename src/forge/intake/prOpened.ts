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
  input: { prUrl: string; title: string; body: string },
  env: PrOpenedEnv,
  emit: (event: PrOpenedEvent) => void,
): Promise<string[]> {
  const keys = ticketKeysIn(`${input.title}\n${input.body}`);
  if (keys.length === 0) {
    emit({ event: 'pr-opened.no-key', prUrl: input.prUrl });
    return [`${input.prUrl} names no ticket key; nothing to move`];
  }

  const lines: string[] = [];
  for (const ticket of keys) {
    if (env.wipAccountId) {
      lines.push(await perform('pr-opened.assigned', ticket, input.prUrl, () => client.assign(ticket, env.wipAccountId!), emit));
    }
    if (env.wipTransitionId) {
      lines.push(await perform('pr-opened.transitioned', ticket, input.prUrl, () => client.transition(ticket, env.wipTransitionId!), emit));
    }
    // The link is what makes the pull request findable from the ticket at all, which is
    // the half of this that the in-flight check reads back.
    const link = await client.link(ticket, input.prUrl);
    lines.push(link.ok ? `pr-opened.linked: ${ticket} ok` : `pr-opened.linked: ${ticket} failed (${link.status ?? 'no status'})`);
  }
  if (!env.wipAccountId && !env.wipTransitionId) {
    lines.push('no assignee or transition configured; the ticket was linked but not moved');
  }
  return lines;
}
