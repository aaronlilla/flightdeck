/**
 * Requirement 5 — the active-ticket set (spine spec Section 2, "Scope"): a ticket
 * assigned to the account owner runs hands-off; a Sentry or CloudWatch finding becomes
 * a ticket with a packet and a proposed owner; an unassigned Jira/Slack/GitHub backlog
 * item gets a packet and a proposal comment rather than being worked hands-off.
 */
export type TicketOrigin = 'jira' | 'sentry' | 'cloudwatch' | 'slack' | 'github';

export interface ScopeInput {
  assignee: string | undefined;
  origin: TicketOrigin;
}

export type Handling = 'hands-off' | 'finding-with-proposed-owner' | 'backlog-proposal-comment';

export function classifyTicket(input: ScopeInput, ownerAccount: string): { handling: Handling } {
  if (input.assignee === ownerAccount) return { handling: 'hands-off' };
  if (input.origin === 'sentry' || input.origin === 'cloudwatch') {
    return { handling: 'finding-with-proposed-owner' };
  }
  return { handling: 'backlog-proposal-comment' };
}
