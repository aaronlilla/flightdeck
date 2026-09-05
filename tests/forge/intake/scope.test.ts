/**
 * Requirement 5 — the active-ticket set: "assigned-to-Aaron runs hands-off; Sentry/
 * CloudWatch findings become tickets with a packet and a proposed owner; unassigned
 * backlog items get a packet and a proposal comment" (spine spec Section 2, "Scope").
 */
import { describe, expect, it } from 'vitest';

import { classifyTicket } from '../../../src/forge/intake/scope.js';

const OWNER = 'account-holder@example.com';

describe('classifyTicket', () => {
  it('a ticket assigned to the owner runs hands off', () => {
    const result = classifyTicket({ assignee: OWNER, origin: 'jira' }, OWNER);
    expect(result).toEqual({ handling: 'hands-off' });
  });

  it('a Sentry-originated finding becomes a ticket with a packet and a proposed owner', () => {
    const result = classifyTicket({ assignee: undefined, origin: 'sentry' }, OWNER);
    expect(result).toEqual({ handling: 'finding-with-proposed-owner' });
  });

  it('a CloudWatch-originated finding is handled the same way as a Sentry one', () => {
    const result = classifyTicket({ assignee: undefined, origin: 'cloudwatch' }, OWNER);
    expect(result).toEqual({ handling: 'finding-with-proposed-owner' });
  });

  it('an unassigned Jira backlog item gets a packet and a proposal comment, never hands-off', () => {
    const result = classifyTicket({ assignee: undefined, origin: 'jira' }, OWNER);
    expect(result).toEqual({ handling: 'backlog-proposal-comment' });
  });

  it('a ticket assigned to someone other than the owner is never hands-off', () => {
    const result = classifyTicket({ assignee: 'someone-else@example.com', origin: 'jira' }, OWNER);
    expect(result.handling).not.toBe('hands-off');
  });
});
