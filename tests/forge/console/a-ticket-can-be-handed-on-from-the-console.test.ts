import { describe, expect, it, vi } from 'vitest';

import { handOffTicket, type TicketHandoffDeps } from '../../../src/forge/console/ticket-handoff.js';

/**
 * Handing a ticket on, from the console rather than from a terminal.
 *
 * Aaron, 2026-09-13: every ticket should go from the board to its destination through the
 * console's own screens. Four of the actions that takes did not exist there at all --
 * commenting, assigning, transitioning, and opening a pull request. The first three are
 * one action as a person does them: a finished ticket is commented, moved and handed to
 * somebody in one motion, and doing two of the three leaves the board lying.
 *
 * The writing was already built (`jiraHandoff.ts` has run all three for the worker since
 * before this). What was missing was a way to ask for it. This is that, plus the honesty
 * the worker's version does not need and a screen does: the worker silently skips a step
 * whose environment variable is unset, which on a screen is a step a person believes
 * happened.
 */
function deps(over: Partial<TicketHandoffDeps> = {}): TicketHandoffDeps {
  return {
    client: {
      comment: vi.fn(async () => ({ ok: true })),
      assign: vi.fn(async () => ({ ok: true })),
      transition: vi.fn(async () => ({ ok: true })),
    },
    people: { qa: { accountId: 'acct-qa', transitionId: '31', name: 'QA' } },
    ...over,
  } as TicketHandoffDeps;
}

describe('handing a ticket on', () => {
  it('comments, assigns and transitions, in that order', async () => {
    const d = deps();
    const result = await handOffTicket('ABC-1', 'qa', 'done, over to you', d);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(['comment', 'assign', 'transition']);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it('carries the comment text through rather than writing its own', async () => {
    const d = deps();
    await handOffTicket('ABC-1', 'qa', 'look at the deposit screen', d);
    expect((d.client!.comment as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe('look at the deposit screen');
  });

  // One failing write must never suppress the next. A comment that bounces off a
  // readability rule cannot be allowed to leave the ticket unassigned as well.
  it('runs every step even when an earlier one fails', async () => {
    const d = deps();
    d.client!.comment = vi.fn(async () => ({ ok: false, body: 'readability refused this comment' }));
    const result = await handOffTicket('ABC-1', 'qa', 'x', d);
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.ok)).toEqual([false, true, true]);
    expect(result.steps[0]?.detail).toMatch(/readability/);
  });

  it('says which step failed rather than reporting one verdict for three writes', async () => {
    const d = deps();
    d.client!.transition = vi.fn(async () => ({ ok: false, body: 'transition 31 is not available' }));
    const result = await handOffTicket('ABC-1', 'qa', 'x', d);
    expect(result.steps.find((s) => s.name === 'transition')?.detail).toMatch(/not available/);
    expect(result.steps.filter((s) => s.ok)).toHaveLength(2);
  });

  // The worker's version skips a step whose environment variable is unset and says
  // nothing. On a screen that is a step somebody believes happened.
  it('reports a step it could not attempt, rather than skipping it quietly', async () => {
    const d = deps({ people: { qa: { accountId: null, transitionId: '31', name: 'QA' } } } as never);
    const result = await handOffTicket('ABC-1', 'qa', 'x', d);
    const assign = result.steps.find((s) => s.name === 'assign');
    expect(assign?.ok).toBe(false);
    expect(assign?.detail, 'it has to name what is unset').toMatch(/account/i);
    expect(result.ok).toBe(false);
  });

  it('refuses a destination nobody is configured for, by name', async () => {
    const result = await handOffTicket('ABC-1', 'nobody', 'x', deps());
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(0);
    expect(result.refused).toMatch(/nobody/);
  });

  it('refuses with no credentials wired, rather than reporting success', async () => {
    const result = await handOffTicket('ABC-1', 'qa', 'x', deps({ client: null }));
    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/jira/i);
  });

  it('refuses an empty comment rather than posting a blank one', async () => {
    const result = await handOffTicket('ABC-1', 'qa', '   ', deps());
    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/comment/i);
  });
});
