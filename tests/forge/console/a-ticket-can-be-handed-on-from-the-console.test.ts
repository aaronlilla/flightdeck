import { describe, expect, it, vi } from 'vitest';

import { handOffTicket, handoffPeopleFromEnv, type TicketHandoffDeps } from '../../../src/forge/console/ticket-handoff.js';
import { HANDOFF_DESTINATIONS } from '../../../src/shared/console-model.js';

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

  // Found by code review: the screen, the route's people map and the stub each carried
  // their own hardcoded copy of this list, behind a comment claiming they could not
  // drift. Adding a destination left the screen offering the old three; renaming an id
  // made the screen send a value the route refused. One list now, and this says so.
  it('knows exactly the destinations the shared list names', () => {
    const people = handoffPeopleFromEnv({} as NodeJS.ProcessEnv);
    expect(Object.keys(people).sort()).toEqual(HANDOFF_DESTINATIONS.map((who) => who.id).sort());
    for (const who of HANDOFF_DESTINATIONS) {
      expect(people[who.id]?.name, who.id).toBe(who.name);
    }
  });

  // A null prototype, so the unknown-destination guard cannot be walked past.
  it('has no destinations inherited from Object.prototype', async () => {
    for (const to of ['constructor', '__proto__', 'toString', 'valueOf']) {
      const result = await handOffTicket('ABC-1', to, 'x', {
        client: deps().client, people: handoffPeopleFromEnv({} as NodeJS.ProcessEnv),
      });
      expect(result.refused, to).toMatch(/not somebody this console can hand to/);
      expect(result.steps, to).toHaveLength(0);
    }
  });

  // Found by design critique. The Jira write client does not wrap its fetch, so a
  // network-level failure -- DNS, connection refused, TLS, timeout -- REJECTS rather
  // than returning a result. A straight await chain then aborts: the steps after it
  // never run, and the rejection escapes the route so the browser is never answered at
  // all. The worker's own path has caught this since `performOne`; this one did not.
  it('turns a thrown write into a failed step and keeps going', async () => {
    const d = deps();
    d.client!.assign = vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:443'); });

    const result = await handOffTicket('ABC-1', 'qa', 'x', d);

    expect(result.steps.map((s) => s.name)).toEqual(['comment', 'assign', 'transition']);
    expect(result.steps.find((s) => s.name === 'assign')?.ok).toBe(false);
    expect(result.steps.find((s) => s.name === 'assign')?.detail).toMatch(/ECONNREFUSED/);
    // The one after it still ran. A blip on the assignment must not silently swallow
    // the transition.
    expect(result.steps.find((s) => s.name === 'transition')?.ok).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('never rejects, whatever the client does, so the caller is always answered', async () => {
    const d = deps();
    d.client!.comment = vi.fn(async () => { throw new Error('socket hang up'); });
    d.client!.assign = vi.fn(async () => { throw new Error('socket hang up'); });
    d.client!.transition = vi.fn(async () => { throw new Error('socket hang up'); });

    const result = await handOffTicket('ABC-1', 'qa', 'x', d);

    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => !s.ok)).toBe(true);
    expect(result.steps.every((s) => /socket hang up/.test(s.detail))).toBe(true);
  });

  // Found by design critique, and it is the destination the brief exists for. The
  // backend prefix was invented here: nothing else in the repository sets
  // FORGE_JIRA_BACKEND_ACCOUNT. The convention that does exist is
  // FORGE_JIRA_BACKEND_OWNER_ACCOUNT, read by the backend ping in queue-wire.ts. So
  // handing a ticket to the backend lead could never assign it, whatever was configured.
  it('reads the backend lead from the setting the rest of the repo already uses', () => {
    const people = handoffPeopleFromEnv({
      FORGE_JIRA_BACKEND_OWNER_ACCOUNT: 'acct-joe',
      FORGE_JIRA_BACKEND_OWNER_TRANSITION: '41',
    } as NodeJS.ProcessEnv);

    expect(people['backend']?.accountId).toBe('acct-joe');
    expect(people['backend']?.transitionId).toBe('41');
  });

  // The queue path runs voiceGuard before it posts, to keep agent self-narration and
  // Aaron in the third person off tickets Joe and Haiping read. This is the first caller
  // that pipes an operator's freely typed prose into that write.
  it('refuses a comment voiceGuard would refuse, before writing anything', async () => {
    const d = deps();
    const result = await handOffTicket(
      'ABC-1', 'qa', 'Aaron reported this one; fixed in this session.', d,
    );

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/reads wrong for a ticket.*third person/i);
    expect(result.steps).toHaveLength(0);
    expect((d.client!.comment as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
