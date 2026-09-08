import { describe, expect, it } from 'vitest';

import { ticketFromBrief } from '../../../src/forge/intake/repoRoute.js';

// A hand-written brief for a real ticket carries no packet id the planner can hand to
// Jira. The `ticket:` line is the only way such a brief reaches its own ticket's
// routing, branch name and Jira handoff instead of a synthetic queue-brief id.
describe('ticketFromBrief', () => {
  it('reads a ticket: KEY-123 line anywhere in the brief', () => {
    expect(ticketFromBrief(['# Goal: x', '', 'ticket: BBZ-178', ''].join('\n'))).toBe('BBZ-178');
    expect(ticketFromBrief(['body text', 'more body', 'ticket: ABC123-42'].join('\n'))).toBe('ABC123-42');
  });

  it('returns null without a ticket: line', () => {
    expect(ticketFromBrief(['# Goal: x', '', 'no header here'].join('\n'))).toBeNull();
    expect(ticketFromBrief('')).toBeNull();
  });

  it('ignores a lowercase or malformed key', () => {
    expect(ticketFromBrief('ticket: bbz-178')).toBeNull();
    expect(ticketFromBrief('ticket: 178')).toBeNull();
    expect(ticketFromBrief('ticket: BBZ')).toBeNull();
    expect(ticketFromBrief('ticket: BBZ178')).toBeNull();
    expect(ticketFromBrief('Ticket: BBZ-178')).toBeNull();
    expect(ticketFromBrief('ticket:BBZ-178extra text')).toBeNull();
  });
});
