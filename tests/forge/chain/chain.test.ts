/**
 * P5.7: the chain hops in `chain.ts`, against fakes for every dependency -- no network
 * call, no spawned process, no real git worktree. Every specimen builds its own
 * `ChainDeps` and its own in-memory journal (an array `append` pushes onto), then folds
 * that array with `foldChainState` the same way `forge status`/`up` would fold the real
 * journal, so the specimens exercise the exact state machine production runs.
 */
import { describe, expect, it } from 'vitest';

import {
  chainStatusLines, chainStatusRows, completeBriefWithVerification, foldChainState, runChainTick, runKeyForBrief,
  type ChainDeps, type ChainPacketState, type ChainPlannedPacket, type ChainRunStatus,
} from '../../../src/forge/chain.js';
import { checkHandoff } from '../../../src/forge/contracts.js';
import { findHaipingHandoff } from '../../../src/forge/council/handoffScan.js';

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
        {
          worktreePath: `C:/worktrees/repo--${ticket.toLowerCase()}`, branch: `feature/${ticket.toLowerCase()}`,
          base: 'develop',
        }
      ),
      launch: async ({ ticket }) => ({ runKey: ticket.toLowerCase() }),
      status: async (): Promise<ChainRunStatus> => ({ finished: false }),
      runRegistered: async () => false,
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

  it('the council call carries cwd and baseRef from the provisioned row', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let statusCalls = 0;
    let councilInput: Record<string, unknown> | undefined;
    const fixture = buildFixture({
      planned,
      launcher: {
        provision: async () => ({ worktreePath: 'C:/worktrees/repo--abc-1', branch: 'feature/abc-1', base: 'develop' }),
        status: async () => {
          statusCalls += 1;
          return statusCalls < 2
            ? { finished: false }
            : { finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/42' };
        },
      },
      council: async (input) => { councilInput = input; return { verdict: 'PASS' }; },
    });

    await runChainTick(fixture.deps, fixture.state);
    await runChainTick(fixture.deps, foldChainState(fixture.events));
    await runChainTick(fixture.deps, foldChainState(fixture.events));

    expect(councilInput).toMatchObject({
      repo: 'owner/name', pr: 42, forceCodex: true,
      // The remote ref, not the local branch: the local one is only as fresh as the last
      // fetch, and reviewing against it puts everything merged since inside this diff.
      cwd: 'C:/worktrees/repo--abc-1', baseRef: 'origin/develop',
    });
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
        provision: async () => {
          provisionCalls += 1;
          return { worktreePath: 'C:/wt', branch: 'feature/abc-1', base: 'develop' };
        },
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

  it('D1: carries reused: true from the launcher onto the chain.provisioned row', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    const fixture = buildFixture({
      planned,
      launcher: {
        provision: async () => (
          { worktreePath: 'C:/worktrees/repo--abc-1', branch: 'feature/abc-1', base: 'develop', reused: true }
        ),
      },
    });

    await runChainTick(fixture.deps, fixture.state);

    const provisioned = fixture.events.find((event) => event['event'] === 'chain.provisioned');
    expect(provisioned?.['reused']).toBe(true);
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

describe('C2: chain.unblocked', () => {
  it('clears a blocked packet\'s state, so the next tick runs the hop it stopped at again', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let provisionCalls = 0;
    const fixture = buildFixture({
      planned,
      launcher: {
        provision: async () => {
          provisionCalls += 1;
          if (provisionCalls === 1) throw new Error('spawn npm ENOENT');
          return { worktreePath: 'C:/wt', branch: 'feature/abc-1', base: 'develop' };
        },
      },
    });

    await runChainTick(fixture.deps, fixture.state);
    expect(eventNames(fixture.events)).toEqual(['intake.planned', 'chain.blocked']);
    let state = foldChainState(fixture.events);
    expect(state.get('p1')?.blocked?.hop).toBe('provision');

    // A second tick while still blocked never retries on its own.
    await runChainTick(fixture.deps, state);
    expect(provisionCalls).toBe(1);

    fixture.deps.append({ event: 'chain.unblocked', actor: 'aaron', packetId: 'p1', reason: 'shell fix landed' });
    state = foldChainState(fixture.events);
    expect(state.get('p1')?.blocked).toBeUndefined();

    await runChainTick(fixture.deps, state);
    expect(provisionCalls).toBe(2);
    expect(eventNames(fixture.events)).toEqual([
      'intake.planned', 'chain.blocked', 'chain.unblocked', 'chain.provisioned', 'chain.launched',
    ]);
  });

  it('reuses an already-provisioned worktree rather than provisioning again', async () => {
    const planned: ChainPlannedPacket[] = [{ packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' }];
    let provisionCalls = 0;
    let launchCalls = 0;
    const fixture = buildFixture({
      planned,
      launcher: {
        provision: async () => { provisionCalls += 1; return { worktreePath: 'C:/wt', branch: 'feature/abc-1', base: 'develop' }; },
        launch: async () => { launchCalls += 1; throw new Error('spawn ENOENT'); },
      },
    });

    await runChainTick(fixture.deps, fixture.state);
    let state = foldChainState(fixture.events);
    expect(state.get('p1')?.blocked?.hop).toBe('launch');
    expect(provisionCalls).toBe(1);

    fixture.deps.append({ event: 'chain.unblocked', actor: 'aaron', packetId: 'p1' });
    state = foldChainState(fixture.events);
    await runChainTick(fixture.deps, state);

    expect(provisionCalls).toBe(1);
    expect(launchCalls).toBe(2);
  });
});

describe('chainStatusLines', () => {
  it('shows a row unblocked and re-provisioning, not stuck on the old blocked reason', () => {
    const events: Record<string, unknown>[] = [
      { event: 'intake.planned', packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'x' },
      { event: 'chain.blocked', packetId: 'p1', hop: 'provision', reason: 'spawn npm ENOENT' },
      { event: 'chain.unblocked', packetId: 'p1', reason: 'shell fix landed' },
    ];
    const lines = chainStatusLines(foldChainState(events));
    expect(lines.find((line) => line.includes('ABC-1'))).not.toContain('ENOENT');
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
    // A worker asked, live on 2026-09-07, whether to commit and whether to touch the
    // ticket tracker it could not reach. Both answers now travel with every brief.
    expect(completed).toContain('## How this run ends');
    expect(completed).toContain('Never ask whether');
    expect(completed).toContain('Do not write to');

    // Q-56a42646 / PR #121: a worker with no access to flightdeck's own source invented
    // fields (screen, whatChanged...) because the block only named the schema. The
    // appended text now shows the real shape, filled with placeholders, plus the two
    // rules a worker needs to fill it in correctly.
    expect(completed).toContain('```json');
    const example = /```json\n([\s\S]*?)\n```/.exec(completed)?.[1];
    expect(example).toBeDefined();
    expect(checkHandoff('haiping', JSON.parse(example!)).complete).toBe(true);
    expect(completed).toContain('rebuild');
    expect(completed).toContain('android/');
    expect(completed).toContain('notVisuallyVerified');
    expect(completed).toContain('no agent looks at a screen');

    expect(findHaipingHandoff(completed)).toBeDefined();
  });

  it('leaves a brief that already carries a Verification block unchanged', () => {
    const brief = '# Goal: fix the thing\n\n## Verification\n\n```\nnpm test\n```\n';
    const completed = completeBriefWithVerification(brief, {
      ticket: 'ABC-1', repo: 'owner/name', branch: 'feature/abc-1', base: 'develop',
    });
    expect(completed).toBe(brief);
  });
});

/**
 * F1: the run key `forge run` assigns to any brief -- the file's own basename with a
 * trailing `.md` stripped. `cli.ts`'s `run` case computes the identical thing for its own
 * `slug`; this is the one place both now call, so they can never disagree about which run
 * a given brief actually became.
 */
describe('runKeyForBrief', () => {
  it('is the basename with the extension stripped', () => {
    expect(runKeyForBrief('/goals/jira_ABC-226_20260905.md')).toBe('jira_ABC-226_20260905');
    expect(runKeyForBrief('/repo/briefs/p1.md')).toBe('p1');
  });

  it('handles a Windows-style path with backslashes', () => {
    expect(runKeyForBrief('C:\\wt\\briefs\\p1.md')).toBe('p1');
  });

  it('is never derived from the ticket -- a ticket-shaped basename is not lower-cased or otherwise touched', () => {
    expect(runKeyForBrief('/briefs/jira_ABC-226_20260905.md')).not.toBe('abc-226');
  });
});

/**
 * F1: the gate hop's finish detection reads back off whatever run key the launcher
 * actually returned -- never one re-derived from the ticket. `runKeyForBrief` in
 * `chain-wire.ts`'s `launch()` is what makes that key the runner's own basename in
 * production; here it only has to be true that `runChainTick` itself never assumes
 * anything about the key's shape.
 */
describe('F1: the chain follows the launcher\'s own run key end to end', () => {
  it('the gate hop polls status and reaches merged using the launcher\'s run key, not one derived from the ticket', async () => {
    const planned: ChainPlannedPacket[] = [
      { packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/jira_ABC-1_20260905.md' },
    ];
    let statusKeySeen: string | undefined;
    let statusCalls = 0;
    const fixture = buildFixture({
      planned,
      launcher: {
        launch: async () => ({ runKey: 'jira_abc-1_20260905' }),
        status: async (runKey) => {
          statusKeySeen = runKey;
          statusCalls += 1;
          return statusCalls < 2
            ? { finished: false }
            : { finished: true, verdict: 'done', prUrl: 'https://github.com/owner/name/pull/7' };
        },
      },
    });

    await runChainTick(fixture.deps, fixture.state);
    await runChainTick(fixture.deps, foldChainState(fixture.events));
    await runChainTick(fixture.deps, foldChainState(fixture.events));

    expect(statusKeySeen).toBe('jira_abc-1_20260905');
    expect(fixture.events.find((event) => event['event'] === 'chain.merged')).toBeDefined();
  });

  it('the status row carries the ticket and the run key', () => {
    const events: Record<string, unknown>[] = [
      { event: 'intake.planned', packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/jira_ABC-1_20260905.md' },
      { event: 'chain.provisioned', packetId: 'p1', worktreePath: 'C:/wt', branch: 'feature/abc-1' },
      { event: 'chain.launched', packetId: 'p1', runKey: 'jira_abc-1_20260905' },
    ];
    const rows = chainStatusRows(foldChainState(events));
    expect(rows[0]).toMatchObject({ ticket: 'ABC-1', runKey: 'jira_abc-1_20260905' });

    const lines = chainStatusLines(foldChainState(events));
    expect(lines[0]).toContain('ABC-1');
    expect(lines[0]).toContain('jira_abc-1_20260905');
  });
});

/**
 * F2: a launch the chain lost track of -- the worker did register, but the process that
 * spawned it (or the wait that followed) never got to journal `chain.launched` for it, so
 * the packet sits at `chain.blocked` on hop `launch` even though nothing about the launch
 * itself failed.
 */
describe('F2: reconcile a launch the chain lost track of', () => {
  it('a packet blocked at launch, with a registered run under the basename key, folds to launched after one tick -- the launcher is never called again', async () => {
    const planned: ChainPlannedPacket[] = [
      { packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/jira_ABC-1_20260905.md' },
    ];
    let launchCalls = 0;
    const fixture = buildFixture({
      planned,
      launcher: {
        launch: async () => { launchCalls += 1; throw new Error('spawn ENOENT'); },
        runRegistered: async (runKey) => runKey === 'jira_ABC-1_20260905',
      },
    });

    await runChainTick(fixture.deps, fixture.state);
    let state = foldChainState(fixture.events);
    expect(state.get('p1')?.blocked?.hop).toBe('launch');
    expect(launchCalls).toBe(1);

    await runChainTick(fixture.deps, state);
    state = foldChainState(fixture.events);

    expect(launchCalls).toBe(1);
    expect(state.get('p1')?.blocked).toBeUndefined();
    expect(state.get('p1')?.launched?.runKey).toBe('jira_ABC-1_20260905');
    const launchedEvent = [...fixture.events].reverse().find((event) => event['event'] === 'chain.launched');
    expect(launchedEvent?.['reconciled']).toBe(true);
  });

  it('a packet blocked at launch with no registered run stays blocked, and the launcher is still never called a second time', async () => {
    const planned: ChainPlannedPacket[] = [
      { packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' },
    ];
    let launchCalls = 0;
    const fixture = buildFixture({
      planned,
      launcher: {
        launch: async () => { launchCalls += 1; throw new Error('spawn ENOENT'); },
        runRegistered: async () => false,
      },
    });

    await runChainTick(fixture.deps, fixture.state);
    let state = foldChainState(fixture.events);
    expect(state.get('p1')?.blocked?.hop).toBe('launch');

    await runChainTick(fixture.deps, state);
    state = foldChainState(fixture.events);

    expect(launchCalls).toBe(1);
    expect(state.get('p1')?.blocked?.hop).toBe('launch');
  });
});
