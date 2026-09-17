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

import { HANDOFF_DESTINATIONS, type HandoffDestinationId } from '../../shared/console-model.js';
import { createJiraWriteClient } from '../intake/jira.js';
import { voiceGuard } from '../intake/voiceGuard.js';
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
 * One write, and never a rejection.
 *
 * The Jira write client does not wrap its `fetch`, so a network-level failure -- DNS,
 * connection refused, TLS, a timeout -- rejects rather than returning a result. In a
 * straight await chain that aborted everything after it AND escaped the route, so the
 * browser was never answered at all: not "two of three landed", not an error, nothing.
 * The worker's own path has caught this since `performOne`; this one had not.
 */
async function attempt(
  name: HandoffStep['name'], done: string, call: () => Promise<{ ok: boolean; body?: string }>,
): Promise<HandoffStep> {
  try {
    const result = await call();
    return { name, ok: result.ok, detail: said(result, done) };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: why.slice(0, 200) };
  }
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
  // The operator types this and a teammate reads it. Every other Jira comment path in
  // this codebase runs voiceGuard first (`queueHandoff.ts`, `jiraProjection.ts`); the
  // write client itself only carries the readability backstop. This is the first caller
  // that pipes freely typed prose in, which is the case voiceGuard exists for.
  const voice = voiceGuard(text);
  if (!voice.ok) return none(`the comment reads wrong for a ticket: ${voice.reason}`);
  // An own-property check, not a plain lookup. `deps.people[to]` resolves `constructor`,
  // `__proto__`, `toString` and `valueOf` on Object.prototype, and those walked past this
  // guard: the comment posted to Jira -- which cannot be taken back -- and only then did
  // the assignment report "no account id is configured for undefined". Found by code
  // review before this shipped.
  const person = Object.prototype.hasOwnProperty.call(deps.people, to) ? deps.people[to] : undefined;
  if (!person) {
    const known = Object.keys(deps.people).filter(Boolean).join(', ') || 'nobody';
    return none(`"${to}" is not somebody this console can hand to; it knows: ${known}`);
  }

  const steps: HandoffStep[] = [];

  const client = deps.client;
  steps.push(await attempt('comment', 'commented', () => client.comment(key, text)));

  if (person.accountId) {
    const accountId = person.accountId;
    steps.push(await attempt('assign', `assigned to ${person.name}`, () => client.assign(key, accountId)));
  } else {
    steps.push({
      name: 'assign', ok: false,
      detail: `no account id is configured for ${person.name}, so nobody was assigned`,
    });
  }

  if (person.transitionId) {
    const transitionId = person.transitionId;
    steps.push(await attempt('transition', 'moved', () => client.transition(key, transitionId)));
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
const SETTING_PREFIX: Record<HandoffDestinationId, string> = {
  // `backend` is FORGE_JIRA_BACKEND_OWNER, not FORGE_JIRA_BACKEND. The second name was
  // invented here and nothing else in the repository sets it, so handing a ticket to the
  // backend lead could never assign it, whatever was configured. The first is the one the
  // backend ping in `queue-wire.ts` already reads. Found by design critique.
  qa: 'FORGE_JIRA_QA', backend: 'FORGE_JIRA_BACKEND_OWNER', me: 'FORGE_JIRA_WIP',
};

export function handoffPeopleFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, HandoffPerson> {
  // Built off the shared list, and with a null prototype, so `people['constructor']`
  // is absent rather than resolving to something the unknown-destination guard lets by.
  const people: Record<string, HandoffPerson> = Object.create(null) as Record<string, HandoffPerson>;
  for (const { id, name } of HANDOFF_DESTINATIONS) {
    const prefix = SETTING_PREFIX[id];
    people[id] = {
      name,
      accountId: env[`${prefix}_ACCOUNT`] ?? null,
      transitionId: env[`${prefix}_TRANSITION`] ?? null,
    };
  }
  return people;
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
