/**
 * Handing a ticket on to the person who takes it next.
 *
 * A finished ticket is commented, assigned and moved in one motion, and doing two of the
 * three leaves the board saying something untrue. The worker has done all three since
 * before this (`intake/jiraHandoff.ts`); what did not exist was any way to ask for it
 * from a screen, so every handoff was a terminal job (Aaron, 2026-09-13).
 *
 * One difference from the worker's version, and it is deliberate. That one skips a step
 * whose environment variable is unset and says nothing, which is right for a background
 * pass nobody is watching. On a screen it is a step somebody believes happened. Here an
 * unattemptable step is a failed step that names what is unset.
 */

import { createJiraWriteClient } from '../intake/jira.js';
import { jiraConfigFromEnv } from '../queue-wire.js';

/** The three writes, each reported on its own. A caller needs to know which of them
 *  landed: two of three is a different situation from none, and from all. */
export interface HandoffStep {
  name: 'comment' | 'assign' | 'transition';
  ok: boolean;
  detail: string;
}

export interface HandoffResult {
  ok: boolean;
  steps: HandoffStep[];
  /** Set when nothing was attempted at all, saying why. Empty when the writes ran. */
  refused: string;
}

/** Who a ticket can be handed to, and what that takes on the board. A null here is a
 *  configuration gap, reported rather than skipped. */
export interface HandoffPerson {
  name: string;
  accountId: string | null;
  transitionId: string | null;
}

export interface TicketHandoffDeps {
  /** Null with no Jira credentials wired. The route refuses rather than reporting a
   *  success nothing performed. */
  client: {
    comment(key: string, body: string): Promise<{ ok: boolean; body?: string }>;
    assign(key: string, accountId: string): Promise<{ ok: boolean; body?: string }>;
    transition(key: string, transitionId: string): Promise<{ ok: boolean; body?: string }>;
  } | null;
  people: Record<string, HandoffPerson | undefined>;
}

function said(result: { ok: boolean; body?: string }, done: string): string {
  return result.ok ? done : (result.body ?? 'no reason given').slice(0, 200);
}

/**
 * Comment, then assign, then transition — always in that order, and always all three.
 * A failure in one never stops the next: a comment refused by a wording rule must not
 * leave the ticket unassigned as well.
 */
export async function handOffTicket(
  key: string, to: string, comment: string, deps: TicketHandoffDeps,
): Promise<HandoffResult> {
  const none = (refused: string): HandoffResult => ({ ok: false, steps: [], refused });
  if (!deps.client) {
    return none('no jira credentials are wired into this console, so nothing was written');
  }
  const text = comment.trim();
  if (!text) return none('a handoff carries a comment saying what the next person is looking at');
  const person = deps.people[to];
  if (!person) {
    const known = Object.keys(deps.people).filter(Boolean).join(', ') || 'nobody';
    return none(`"${to}" is not somebody this console can hand to; it knows: ${known}`);
  }

  const steps: HandoffStep[] = [];

  const commented = await deps.client.comment(key, text);
  steps.push({ name: 'comment', ok: commented.ok, detail: said(commented, 'commented') });

  if (person.accountId) {
    const assigned = await deps.client.assign(key, person.accountId);
    steps.push({ name: 'assign', ok: assigned.ok, detail: said(assigned, `assigned to ${person.name}`) });
  } else {
    steps.push({
      name: 'assign', ok: false,
      detail: `no account id is configured for ${person.name}, so nobody was assigned`,
    });
  }

  if (person.transitionId) {
    const moved = await deps.client.transition(key, person.transitionId);
    steps.push({ name: 'transition', ok: moved.ok, detail: said(moved, 'moved') });
  } else {
    steps.push({
      name: 'transition', ok: false,
      detail: `no transition is configured for ${person.name}, so the status was left alone`,
    });
  }

  return { ok: steps.every((step) => step.ok), steps, refused: '' };
}

/**
 * Who this console can hand a ticket to, read from the environment the worker already
 * reads. The names are the roles, not the people: `qa` is whoever `FORGE_JIRA_QA_*`
 * points at, and swapping the person is an environment change, not a code change.
 *
 * A person whose account or transition is unset is still listed. Dropping them would
 * make the control offer fewer destinations with no explanation; listing them means the
 * press comes back naming exactly which variable is missing, which is the whole
 * difference between this and the worker's version.
 */
export function handoffPeopleFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, HandoffPerson> {
  return {
    qa: {
      name: 'QA',
      accountId: env['FORGE_JIRA_QA_ACCOUNT'] ?? null,
      transitionId: env['FORGE_JIRA_QA_TRANSITION'] ?? null,
    },
    backend: {
      name: 'the backend lead',
      accountId: env['FORGE_JIRA_BACKEND_ACCOUNT'] ?? null,
      transitionId: env['FORGE_JIRA_BACKEND_TRANSITION'] ?? null,
    },
    me: {
      name: 'me',
      accountId: env['FORGE_JIRA_WIP_ACCOUNT'] ?? null,
      transitionId: env['FORGE_JIRA_WIP_TRANSITION'] ?? null,
    },
  };
}

/**
 * The dependencies the route runs with. The client is null with no Jira credentials in
 * the environment, and `handOffTicket` refuses on that rather than reporting a success
 * nothing performed.
 */
export function handoffDepsFromEnv(env: NodeJS.ProcessEnv = process.env): TicketHandoffDeps {
  const config = jiraConfigFromEnv(env);
  return {
    client: config ? createJiraWriteClient(config) : null,
    people: handoffPeopleFromEnv(env),
  };
}

/** The destinations a screen can offer, so the control is built from the same list the
 *  route validates against and the two cannot drift apart. */
export function handoffDestinations(env: NodeJS.ProcessEnv = process.env): { id: string; name: string }[] {
  return Object.entries(handoffPeopleFromEnv(env)).map(([id, person]) => ({ id, name: person.name }));
}
