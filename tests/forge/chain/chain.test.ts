/**
 * P5.7: the chain hops in `chain.ts`, against fakes for every dependency -- no network
 * call, no spawned process, no real git worktree. Every specimen builds its own
 * `ChainDeps` and its own in-memory journal (an array `append` pushes onto), then folds
 * that array with `foldChainState` the same way `forge status`/`up` would fold the real
 * journal, so the specimens exercise the exact state machine production runs.
 */
import { describe, expect, it } from 'vitest';

import {
  chainStatusLines, completeBriefWithVerification, foldChainState, runChainTick,
  type ChainDeps, type ChainPacketState, type ChainPlannedPacket, type ChainRunStatus,
} from '../../../src/forge/chain.js';

interface Fixture {
  events: Record<string, unknown>[];
  deps: ChainDeps;
  state: Map<string, ChainPacketState>;
}

function buildFixture(overrides: Partial<{
  planned: ChainPlannedPacket[];
  launcher: Partial<ChainDeps['launcher']>;
  gh: Partial<ChainDeps['gh']>;
  council: ChainDeps['council'];
  gate: ChainDeps['gate'];
  killSwitch: () => boolean;
  mergeAllowed: (repo: string) => boolean;
}> = {}): Fixture {
  const events: Record<string, unknown>[] = [];

  const deps: ChainDeps = {
    intake: async () => overrides.planned ?? [],
    launcher: {
      provision: async ({ ticket }) => (
        { worktreePath: `C:/worktrees/repo--${ticket.toLowerCase()}`, branch: `feature/${ticket.toLowerCase()}` }
      ),
      launch: async ({ ticket }) => ({ runKey: ticket.toLowerCase() }),
      status: async (): Promise<ChainRunStatus> => ({ finished: false }),
      ...overrides.launcher,
    },
    gh: {
      findPrByHead: async () => undefined,
      ...overrides.gh,
    },
    council: overrides.council ?? (async () => ({ verdict: 'PASS' })),
    gate: overrides.gate ?? (async () => ({ merged: true, mergeSha: 'deadbeef' })),
    clock: () => 1_000,
    killSwitch: overrides.killSwitch ?? (() => false),
    mergeAllowed: overrides.mergeAllowed ?? (() => true),
    append: (event) => events.push(event),
  };

  return { events, deps, state: foldChainState(events) };
}

function eventNames(events: Record<string, unknown>[]): string[] {
  return events.map((event) => String(event['event']));
}

describe('runChainTick', () => {
  it('walks a routed packet through provision, launch, done, gate, merge in that order', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let statusCalls = 0;
    const fixture = buildFixture({
      planned,
      launcher: {
        status: async () => {
          statusCalls += 1;
          return statusCalls < 2 ? { finished: false } : { finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/42' };
        },
      },
    });

    await runChainTick(fixture.deps, fixture.state);
    expect(eventNames(fixture.events)).toEqual(['intake.planned', 'chain.provisioned', 'chain.launched']);

    // Second tick: the run is still going.
    await runChainTick(fixture.deps, foldChainState(fixture.events));
    expect(eventNames(fixture.events)).toEqual(['intake.planned', 'chain.provisioned', 'chain.launched']);

    // Third tick: the run finished done, the council passed, and the repo may merge.
    await runChainTick(fixture.deps, foldChainState(fixture.events));
    expect(eventNames(fixture.events)).toEqual([
      'intake.planned', 'chain.provisioned', 'chain.launched', 'chain.gated', 'chain.merged',
    ]);
    const merged = fixture.events.find((event) => event['event'] === 'chain.merged');
    expect(merged?.['mergeSha']).toBe('deadbeef');
  });

  it('blocks an unrouted packet once and a second poll does not repeat the row', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'unknown', briefPath: 'C:/briefs/p1.md' }];
    const fixture = buildFixture({ planned });

    await runChainTick(fixture.deps, fixture.state);
    expect(eventNames(fixture.events)).toEqual(['intake.planned', 'chain.blocked']);

    // Same packet planned again on a second poll (the intake fake keeps returning it) --
    // the tick must not journal a second chain.blocked row for it.
    await runChainTick(fixture.deps, foldChainState(fixture.events));
    expect(eventNames(fixture.events).filter((name) => name === 'chain.blocked')).toHaveLength(1);
  });

  it('never relaunches a packet a prior tick already launched', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let provisionCalls = 0;
    let launchCalls = 0;
    const fixture = buildFixture({
      planned,
      launcher: {
        provision: async () => { provisionCalls += 1; return { worktreePath: 'C:/wt', branch: 'feature/abc-1' }; },
        launch: async () => { launchCalls += 1; return { runKey: 'abc-1' }; },
        status: async () => ({ finished: false }),
      },
    });

    await runChainTick(fixture.deps, fixture.state);
    await runChainTick(fixture.deps, foldChainState(fixture.events));
    await runChainTick(fixture.deps, foldChainState(fixture.events));

    expect(provisionCalls).toBe(1);
    expect(launchCalls).toBe(1);
  });

  it('blocks with the verdict when the worker finishes with anything other than done', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    const fixture = buildFixture({
      planned,
      launcher: { status: async () => ({ finished: true, verdict: 'parked', lastHandoff: 'waiting on a decision' }) },
    });

    await runChainTick(fixture.deps, fixture.state);
    await runChainTick(fixture.deps, foldChainState(fixture.events));

    const blocked = fixture.events.find((event) => event['event'] === 'chain.blocked' && event['hop'] === 'gate');
    expect(blocked?.['reason']).toBe('parked');
    expect(blocked?.['lastHandoff']).toBe('waiting on a decision');
  });

  it('stops at the draft PR for a repository outside FORGE_CHAIN_MERGE', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let gateMergeArg: boolean | undefined;
    const fixture = buildFixture({
      planned,
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/9' }) },
      mergeAllowed: () => false,
      gate: async (input) => { gateMergeArg = input.merge; return { merged: false }; },
    });

    await runChainTick(fixture.deps, fixture.state);
    await runChainTick(fixture.deps, foldChainState(fixture.events));

    expect(gateMergeArg).toBe(false);
    const stopped = fixture.events.find((event) => event['event'] === 'chain.stopped');
    expect(stopped?.['reason']).toBe('draft-pr');
  });

  it('stops the chain at H4 when the kill switch is set before the gate', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let councilCalled = false;
    const fixture = buildFixture({
      planned,
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async () => { councilCalled = true; return { verdict: 'PASS' }; },
      killSwitch: () => true,
    });

    // With the kill switch already on, H1 never polls; seed the planned packet directly
    // as though an earlier tick (before the switch was set) already planned it.
    fixture.deps.append({ event: 'intake.planned', actor: 'intake', packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' });
    await runChainTick(fixture.deps, foldChainState(fixture.events));

    expect(councilCalled).toBe(false);
    const stopped = fixture.events.find((event) => event['event'] === 'chain.stopped');
    expect(stopped?.['reason']).toBe('kill-switch');
  });

  it('forces the Codex lane on for every chain council call', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let sawForceCodex: boolean | undefined;
    const fixture = buildFixture({
      planned,
      launcher: { status: async () => ({ finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/1' }) },
      council: async (input) => { sawForceCodex = input.forceCodex; return { verdict: 'PASS' }; },
    });

    await runChainTick(fixture.deps, fixture.state);
    await runChainTick(fixture.deps, foldChainState(fixture.events));

    expect(sawForceCodex).toBe(true);
  });

  it('blocks with the command tail when the worktree setup command fails', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    const fixture = buildFixture({
      planned,
      launcher: {
        provision: async () => { throw new Error('npm ci failed: EACCES on node_modules/.bin/tsc'); },
      },
    });

    await runChainTick(fixture.deps, fixture.state);

    const blocked = fixture.events.find((event) => event['event'] === 'chain.blocked');
    expect(blocked?.['hop']).toBe('provision');
    expect(String(blocked?.['reason'])).toContain('EACCES on node_modules/.bin/tsc');
  });
});

describe('chainStatusLines', () => {
  it('prints one row per packet with its ticket, hop and state', () => {
    const events: Record<string, unknown>[] = [
      { event: 'intake.planned', packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'x' },
      { event: 'chain.provisioned', packetId: 'p1', worktreePath: 'C:/wt', branch: 'feature/abc-1' },
      { event: 'intake.planned', packetId: 'p2', ticket: 'ABC-2', repo: 'unknown', briefPath: 'y' },
      { event: 'chain.blocked', packetId: 'p2', hop: 'unrouted', reason: 'unrouted' },
    ];
    const lines = chainStatusLines(foldChainState(events));
    expect(lines).toContainEqual(expect.stringContaining('ABC-1'));
    expect(lines.find((line) => line.includes('ABC-2'))).toContain('unrouted');
  });
});

describe('completeBriefWithVerification', () => {
  it('appends a Verification block naming the command, branch, base, ticket and the handoff instruction', () => {
    const brief = '# Goal: fix the thing\n\nDo the work.';
    const completed = completeBriefWithVerification(brief, {
      ticket: 'ABC-1', repo: 'owner/name', branch: 'feature/abc-1', base: 'develop', verifyCommand: 'npm run verify',
    });

    expect(completed).toContain('## Verification');
    expect(completed).toContain('npm run verify');
    expect(completed).toContain('feature/abc-1');
    expect(completed).toContain('develop');
    expect(completed).toContain('ABC-1');
    expect(completed).toContain('HaipingHandoffSchema');
    expect(completed).toContain('forge_done');
  });

  it('leaves a brief that already carries a Verification block unchanged', () => {
    const brief = '# Goal: fix the thing\n\n## Verification\n\n```\nnpm test\n```\n';
    const completed = completeBriefWithVerification(brief, {
      ticket: 'ABC-1', repo: 'owner/name', branch: 'feature/abc-1', base: 'develop',
    });
    expect(completed).toBe(brief);
  });
});
