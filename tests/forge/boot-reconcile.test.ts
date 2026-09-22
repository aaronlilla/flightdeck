/**
 * Specimens for `src/forge/boot-reconcile.ts`.
 *
 * Nothing here shells out or reaches a network: `git` is a recorded map from argv to a
 * result, and the inbox is an in-memory stand-in with the same two methods the passes use.
 * Each specimen pins one of the four stale-state incidents the module exists to prevent.
 */
import { describe, expect, it } from 'vitest';

import {
  bootReconcile,
  reconcileCheckouts,
  reconcileRunClones,
  retireAnsweredJiraAsks,
  retireDeadAsks,
  type GitRun,
} from '../../src/forge/boot-reconcile.js';
import type { InboxEntry } from '../../src/forge/inbox.js';

/** A git stand-in driven by a table keyed on the joined argv, so a specimen states the
 *  repository's shape rather than simulating git. Anything unlisted answers `ok: false`,
 *  which is what an unreadable repository looks like. */
function fakeGit(table: Record<string, { ok: boolean; out: string }>, calls: string[] = []): GitRun {
  return async (cwd, args) => {
    const key = args.join(' ');
    calls.push(`${cwd}|${key}`);
    return table[key] ?? { ok: false, out: '' };
  };
}

function entry(over: Partial<InboxEntry> & { key: string }): InboxEntry {
  return {
    key: over.key,
    question: over.question ?? 'why',
    options: over.options ?? [],
    kind: 'question',
    runs: over.runs ?? [],
    goals: over.goals ?? [],
    asked: 1,
    at: over.at ?? 1_000,
    disposition: 'park',
    ...(over.ticket ? { ticket: over.ticket } : {}),
    ...(over.sourceCommentAt !== undefined ? { sourceCommentAt: over.sourceCommentAt } : {}),
    ...(over.answer !== undefined ? { answer: over.answer } : {}),
  } as InboxEntry;
}

function fakeInbox(entries: InboxEntry[]) {
  const live = new Map(entries.map((e) => [e.key, e]));
  return {
    retired: [] as string[],
    open() { return [...live.values()]; },
    retire(key: string) {
      const found = live.get(key);
      if (!found) return undefined;
      live.delete(key);
      this.retired.push(key);
      return found;
    },
  };
}

describe('reconcileCheckouts', () => {
  it('fast-forwards a base branch the fetch moved but the branch did not follow', async () => {
    // The 2026-09-21 shape exactly: origin/develop 86 ahead of the local develop every run
    // clone is cut from, on a checkout with no branch checked out.
    const calls: string[] = [];
    const git = fakeGit({
      'fetch --prune origin develop': { ok: true, out: '' },
      'rev-list --count develop..origin/develop': { ok: true, out: '86' },
      'rev-list --count origin/develop..develop': { ok: true, out: '0' },
      'symbolic-ref --quiet --short HEAD': { ok: false, out: '' },
      'update-ref refs/heads/develop refs/remotes/origin/develop': { ok: true, out: '' },
    }, calls);

    const { outcomes, failures } = await reconcileCheckouts(
      [{ repo: 'O/N', checkout: 'C:/checkout', base: 'develop' }], git,
    );

    expect(failures).toEqual([]);
    expect(outcomes).toEqual([{ repo: 'O/N', checkout: 'C:/checkout', base: 'develop', behindBefore: 86, fastForwarded: true }]);
    expect(calls).toContain('C:/checkout|update-ref refs/heads/develop refs/remotes/origin/develop');
  });

  it('merges instead of moving the ref when the checkout is actually on that branch', async () => {
    const calls: string[] = [];
    const git = fakeGit({
      'fetch --prune origin develop': { ok: true, out: '' },
      'rev-list --count develop..origin/develop': { ok: true, out: '3' },
      'rev-list --count origin/develop..develop': { ok: true, out: '0' },
      'symbolic-ref --quiet --short HEAD': { ok: true, out: 'develop\n' },
      'merge --ff-only origin/develop': { ok: true, out: '' },
    }, calls);

    const { outcomes } = await reconcileCheckouts([{ repo: 'O/N', checkout: 'C:/c', base: 'develop' }], git);

    expect(outcomes[0]?.fastForwarded).toBe(true);
    expect(calls).toContain('C:/c|merge --ff-only origin/develop');
    expect(calls.some((c) => c.includes('update-ref'))).toBe(false);
  });

  it('leaves a diverged base alone and says so rather than dropping local commits', async () => {
    const git = fakeGit({
      'fetch --prune origin develop': { ok: true, out: '' },
      'rev-list --count develop..origin/develop': { ok: true, out: '4' },
      'rev-list --count origin/develop..develop': { ok: true, out: '2' },
    });

    const { outcomes, failures } = await reconcileCheckouts([{ repo: 'O/N', checkout: 'C:/c', base: 'develop' }], git);

    expect(outcomes[0]?.fastForwarded).toBe(false);
    expect(outcomes[0]?.reason).toContain('diverged');
    expect(failures).toHaveLength(1);
  });

  it('reports an unreachable remote as a failure without throwing', async () => {
    const { outcomes, failures } = await reconcileCheckouts(
      [{ repo: 'O/N', checkout: 'C:/c', base: 'develop' }], fakeGit({}),
    );
    expect(outcomes[0]?.fastForwarded).toBe(false);
    expect(failures[0]).toContain('could not fetch');
  });
});

describe('reconcileRunClones', () => {
  it('never moves a clone that has uncommitted work', async () => {
    const calls: string[] = [];
    const git = fakeGit({
      'fetch --prune origin develop': { ok: true, out: '' },
      'rev-list --count HEAD..origin/develop': { ok: true, out: '85' },
      'status --porcelain': { ok: true, out: ' M src/App.tsx\n' },
    }, calls);

    const { passes } = await reconcileRunClones([{ ticket: 'BBZ-282', clonePath: 'C:/run', base: 'develop' }], git);

    expect(passes[0]).toMatchObject({ behindBefore: 85, refreshed: false, reason: 'uncommitted work left alone' });
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
  });

  it('never moves a clone carrying commits of its own', async () => {
    const git = fakeGit({
      'fetch --prune origin develop': { ok: true, out: '' },
      'rev-list --count HEAD..origin/develop': { ok: true, out: '9' },
      'status --porcelain': { ok: true, out: '' },
      'rev-list --count origin/develop..HEAD': { ok: true, out: '2' },
    });

    const { passes } = await reconcileRunClones([{ ticket: 'BBZ-362', clonePath: 'C:/run', base: 'develop' }], git);

    expect(passes[0]?.refreshed).toBe(false);
    expect(passes[0]?.reason).toContain('2 commit(s) of its own');
  });

  it('fast-forwards a clean clone that is only old', async () => {
    const git = fakeGit({
      'fetch --prune origin develop': { ok: true, out: '' },
      'rev-list --count HEAD..origin/develop': { ok: true, out: '32' },
      'status --porcelain': { ok: true, out: '' },
      'rev-list --count origin/develop..HEAD': { ok: true, out: '0' },
      'merge --ff-only origin/develop': { ok: true, out: '' },
    });

    const { passes } = await reconcileRunClones([{ ticket: 'BBZ-373', clonePath: 'C:/run', base: 'develop' }], git);

    expect(passes[0]).toMatchObject({ behindBefore: 32, refreshed: true });
  });
});

describe('retireDeadAsks', () => {
  it('retires an ask whose every run is gone, and keeps one with a live run', () => {
    const inbox = fakeInbox([
      entry({ key: 'dead', runs: ['queue-BBZ-1-Q-a'] }),
      entry({ key: 'live', runs: ['queue-BBZ-2-Q-b'] }),
    ]);

    const retired = retireDeadAsks(inbox, (run) => run === 'queue-BBZ-2-Q-b', new Set());

    expect(retired.map((r) => r.key)).toEqual(['dead']);
    expect(inbox.open().map((e) => e.key)).toEqual(['live']);
  });

  it('retires an item-scoped ask once its queue item is gone, and spares one still queued', () => {
    // `isAskStale` exempts item-scoped asks on purpose, so without the queue check these
    // 113 entries stay on the board forever. The exemption itself stays intact.
    const inbox = fakeInbox([
      entry({ key: 'gone', runs: ['item:Q-0aa307ce'] }),
      entry({ key: 'queued', runs: ['item:Q-live'] }),
    ]);

    const retired = retireDeadAsks(inbox, () => false, new Set(['Q-live']));

    expect(retired).toEqual([{ key: 'gone', why: 'its queue item is gone' }]);
    expect(inbox.open().map((e) => e.key)).toEqual(['queued']);
  });
  it('never retires a relayed Jira ask on the dead-run rule, however old', () => {
    // These carry `runs: ['jira-feed']`, which has no registry row by construction. The
    // dead-run rule would take every operator question off the board at the first boot.
    const inbox = fakeInbox([entry({ key: 'relay', ticket: 'BBZ-178', runs: ['jira-feed'] })]);

    expect(retireDeadAsks(inbox, () => false, new Set())).toEqual([]);
    expect(inbox.open()).toHaveLength(1);
  });
});

describe('retireAnsweredJiraAsks', () => {
  it('compares against the relayed comment, not the moment the ask was raised', () => {
    // The live failure: Aaron answered at 10:33, the poller raised the ask at 10:34, and
    // comparing against the raise time read his answer as predating the question. Four
    // answered tickets sat on the board because of this one minute.
    const inbox = fakeInbox([entry({
      key: 'a', ticket: 'BBZ-87', at: 1_120_000, sourceCommentAt: 1_000_000,
    })]);

    const retired = retireAnsweredJiraAsks(inbox, 'aaron', new Map([
      ['BBZ-87', [{ authorAccountId: 'aaron', createdMs: 1_060_000 }]],
    ]));

    expect(retired).toEqual([{ key: 'a', ticket: 'BBZ-87', why: 'answered on the ticket after the comment it relays' }]);
  });

  it('falls back to the ask time for an entry written before sourceCommentAt existed', () => {
    const inbox = fakeInbox([entry({ key: 'a', ticket: 'BBZ-96', at: 5_000 })]);

    const retired = retireAnsweredJiraAsks(inbox, 'aaron', new Map([
      ['BBZ-96', [{ authorAccountId: 'haiping', createdMs: 4_000 }, { authorAccountId: 'aaron', createdMs: 9_000 }]],
    ]));

    expect(retired.map((r) => r.why)).toEqual(['answered on the ticket after the comment it relays']);
  });

  it('retires an ask on a ticket assigned to somebody else, whatever the comments say', () => {
    // Fourteen of Haiping's own In Review tickets were on the board because nothing ever
    // asked whose ticket it was.
    const inbox = fakeInbox([entry({ key: 'hers', ticket: 'BBZ-138', at: 1_000 })]);

    const retired = retireAnsweredJiraAsks(inbox, 'aaron', new Map([['BBZ-138', []]]), new Map([
      ['BBZ-138', { assigneeAccountId: 'haiping', statusIsDone: false }],
    ]));

    expect(retired).toEqual([{ key: 'hers', ticket: 'BBZ-138', why: 'the ticket is assigned to somebody else' }]);
  });

  it('keeps an ask on an UNASSIGNED ticket: nobody owns it, so it is still the operator\'s question', () => {
    // Live 2026-09-22: Haiping @-mentioned Aaron on unassigned backlog ticket BBZ-168
    // and the next boot retired it as "assigned to somebody else".
    const inbox = fakeInbox([entry({ key: 'bbz168', ticket: 'BBZ-168', at: 9_000, sourceCommentAt: 9_000 })]);
    expect(retireAnsweredJiraAsks(inbox, 'aaron', new Map([['BBZ-168', []]]), new Map([
      ['BBZ-168', { assigneeAccountId: null, statusIsDone: false }],
    ]))).toEqual([]);
    expect(inbox.open()).toHaveLength(1);
  });

  it('retires an ask on a done ticket the operator still owns', () => {
    const inbox = fakeInbox([entry({ key: 'done', ticket: 'BBZ-311', at: 1_000 })]);

    const retired = retireAnsweredJiraAsks(inbox, 'aaron', new Map([['BBZ-311', []]]), new Map([
      ['BBZ-311', { assigneeAccountId: 'aaron', statusIsDone: true }],
    ]));

    expect(retired[0]?.why).toBe('the ticket is done');
  });

  it('keeps an unanswered ask on a live ticket the operator owns', () => {
    const inbox = fakeInbox([entry({ key: 'mine', ticket: 'BBZ-287', at: 9_000, sourceCommentAt: 9_000 })]);

    expect(retireAnsweredJiraAsks(inbox, 'aaron', new Map([
      ['BBZ-287', [{ authorAccountId: 'haiping', createdMs: 9_500 }]],
    ]), new Map([['BBZ-287', { assigneeAccountId: 'aaron', statusIsDone: false }]]))).toEqual([]);
    expect(inbox.open()).toHaveLength(1);
  });

  it('retires nothing for a ticket whose comments and state could not be read', () => {
    const inbox = fakeInbox([entry({ key: 'a', ticket: 'BBZ-96', at: 1_000 })]);
    expect(retireAnsweredJiraAsks(inbox, 'aaron', new Map())).toEqual([]);
    expect(inbox.open()).toHaveLength(1);
  });
});

describe('bootReconcile', () => {
  it('runs every pass, summarises them, and retires nothing from Jira when it is absent', async () => {
    const inbox = fakeInbox([
      entry({ key: 'dead', runs: ['queue-BBZ-1-Q-a'] }),
      entry({ key: 'answered', ticket: 'BBZ-96', at: 1_000, runs: ['jira-feed'] }),
    ]);
    const git = fakeGit({
      'fetch --prune origin develop': { ok: true, out: '' },
      'rev-list --count develop..origin/develop': { ok: true, out: '86' },
      'rev-list --count origin/develop..develop': { ok: true, out: '0' },
      'symbolic-ref --quiet --short HEAD': { ok: false, out: '' },
      'update-ref refs/heads/develop refs/remotes/origin/develop': { ok: true, out: '' },
      'rev-list --count HEAD..origin/develop': { ok: true, out: '0' },
    });

    const result = await bootReconcile({
      repos: [{ repo: 'O/N', checkout: 'C:/c', base: 'develop' }],
      clones: [{ ticket: 'BBZ-1', clonePath: 'C:/run', base: 'develop' }],
      git,
      inbox,
      hasRegistryRow: () => false,
      liveQueueItemIds: new Set(),
    });

    expect(result.failures).toEqual([]);
    expect(result.lines[0]).toContain('1 of 1 checkout base(s) fast-forwarded');
    expect(result.lines[0]).toContain('O/N +86');
    // 'answered' has a live-looking run and no Jira evidence, so it survives.
    expect(result.retired.map((r) => r.key)).toEqual(['dead']);
  });

  it('keeps going and reports when a checkout cannot be reached', async () => {
    const result = await bootReconcile({
      repos: [{ repo: 'O/N', checkout: 'C:/c', base: 'develop' }],
      clones: [],
      git: fakeGit({}),
      inbox: fakeInbox([]),
      hasRegistryRow: () => true,
      liveQueueItemIds: new Set(),
    });

    expect(result.failures).toHaveLength(1);
    expect(result.lines).toHaveLength(3);
  });
});
