import { describe, expect, it } from 'vitest';

import { ingest, ingestOne, type IngestDeps } from '../../../src/forge/sessions/ingest.js';
import type { ForgeEvent } from '../../../src/forge/journal.js';

function fakeDeps(overrides: Partial<IngestDeps> = {}): { deps: IngestDeps; appended: ForgeEvent[] } {
  const appended: ForgeEvent[] = [];
  let seq = 0;
  const deps: IngestDeps = {
    append: (row) => {
      seq += 1;
      const stamped = { id: `id-${seq}`, seq, at: Date.now(), version: 1, event: 'note', actor: 'runner', ...row } as ForgeEvent;
      appended.push(stamped);
      return stamped;
    },
    lastStopFor: () => undefined,
    sweep: () => ({ releasedLocks: [] }),
    worktreeStatusFor: () => undefined,
    ...overrides,
  };
  return { deps, appended };
}

describe('ingestOne', () => {
  const KINDS = [
    'session.started', 'session.prompt', 'session.stop', 'session.subagent-stop', 'session.ended', 'session.vanished',
    'session.notification',
  ];

  for (const event of KINDS) {
    it(`journals ${event} with an increasing seq`, () => {
      const { deps, appended } = fakeDeps();
      ingestOne(deps, { event, session: 's1' });
      expect(appended[0]?.event).toBe(event);
      expect(appended[0]?.seq).toBe(1);
    });
  }

  it('journals a 7th shape: session.cleanup, arising from a killed session', () => {
    const { deps, appended } = fakeDeps({
      sweep: () => ({ releasedLocks: ['rn-dev-loop'] }),
      worktreeStatusFor: () => ({ path: '/repos/worktrees/rn--x', clean: false, pushed: false }),
    });
    ingestOne(deps, { event: 'session.vanished', session: 's1', cwd: '/repos/worktrees/rn--x' });
    const kinds = appended.map((r) => r.event);
    expect(kinds).toEqual(['session.vanished', 'session.cleanup', 'worktree.left']);
  });

  it('an array body of three lands as three journal rows', () => {
    const { deps, appended } = fakeDeps();
    ingest(deps, [
      { event: 'session.started', session: 's1' },
      { event: 'session.prompt', session: 's1' },
      { event: 'session.stop', session: 's1' },
    ]);
    expect(appended).toHaveLength(3);
    expect(appended.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('a killed session cleanup row carries the fake sweep lock name and dirty-unpushed worktree status, and never deletes the worktree', () => {
    const { deps, appended } = fakeDeps({
      sweep: (sessionId) => {
        expect(sessionId).toBe('s1');
        return { releasedLocks: ['bbms-test-db'] };
      },
      worktreeStatusFor: (sessionId, cwd) => {
        expect(sessionId).toBe('s1');
        expect(cwd).toBe('/repos/worktrees/rn--dirty');
        return { path: '/repos/worktrees/rn--dirty', clean: false, pushed: false };
      },
    });
    ingestOne(deps, { event: 'session.vanished', session: 's1', cwd: '/repos/worktrees/rn--dirty' });

    const cleanup = appended.find((r) => r.event === 'session.cleanup');
    expect(cleanup?.['releasedLocks']).toEqual(['bbms-test-db']);

    const left = appended.find((r) => r.event === 'worktree.left');
    expect(left?.['path']).toBe('/repos/worktrees/rn--dirty');
    expect(left?.['clean']).toBe(false);
    expect(left?.['pushed']).toBe(false);

    // Nothing in this path ever unlinks or removes a directory -- deleting is /done's job.
    expect(appended.every((r) => r.event !== 'worktree.deleted')).toBe(true);
  });

  it('a session ending done (reason=other, closedWithComplete=true) never runs cleanup', () => {
    const { deps, appended } = fakeDeps({
      lastStopFor: () => ({ closedWithComplete: true }),
      sweep: () => {
        throw new Error('sweep must not run for a clean exit');
      },
    });
    ingestOne(deps, { event: 'session.ended', session: 's1', reason: 'other' });
    expect(appended).toHaveLength(1);
  });

  // Read off the live console 2026-09-11 05:30:59: a real Ctrl-C reaches the console as
  // SessionEnd `reason: other` with `closed_with_complete` false, which classifies
  // `unknown`. `unknown` is not a cleanup class, so the class was computed and dropped --
  // the journalled row carried none, and `journal.ts:376` reads the class off that row, so
  // the fold ended up with no exit class for any session that ended cleanly.
  it('records the exit class on the terminal row itself, not only on a cleanup row', () => {
    const { deps, appended } = fakeDeps({ lastStopFor: () => ({ closedWithComplete: false }) });
    ingestOne(deps, { event: 'session.ended', session: 's1', reason: 'other' });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ event: 'session.ended', exitClass: 'unknown' });
  });

  it('rejects an unknown event kind', () => {
    const { deps } = fakeDeps();
    expect(() => ingestOne(deps, { event: 'session.mystery', session: 's1' })).toThrow();
  });
});
