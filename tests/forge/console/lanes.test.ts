/**
 * `GET /lanes`'s mapping, driven by real journal fixtures (`Journal` + `replay`) so a
 * branch here proves it reads the same rows the server folds off disk, not a shape a
 * test invented for itself.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { foldChainState, type ChainPacketState } from '../../../src/forge/chain.js';
import { Journal, replay } from '../../../src/forge/journal.js';
import {
  computeLanes, hopFor, laneStateFor, meaningfulEvents, modelAlias, ticketFor, windowLanes, type LanesInput, laneKindFor,
  titleFromHeading, titleFor, mergeableFor, mergeReadyReportFrom } from '../../../src/forge/console/lanes.js';
import type { RegistryRecord } from '../../../src/forge/registry.js';
import type { Lane, LanesResponse } from '../../../src/shared/console-model.js';
import { laneRecord, type LaneRecord } from '../../../src/forge/supervisor.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-lanes-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

function baseInput(overrides: Partial<LanesInput> = {}): LanesInput {
  return {
    laneRecords: [],
    fleet: { events: [], runs: {}, burn: {}, handoffs: 0, torn: 0, unknownModels: [] },
    chain: new Map(),
    registryGet: () => undefined,
    openAsks: [],
    stuck: [],
    classFor: () => ({ model: 'claude-sonnet-5', effort: 'medium', maxContext: 200_000, maxTurns: 40 }),
    capOverrides: {},
    prFor: () => null,
    tokensPerHour: () => 0,
    ...overrides,
  };
}

describe('modelAlias', () => {
  it('maps sonnet, opus and haiku ids to their short aliases', () => {
    expect(modelAlias('claude-sonnet-5-20260101')).toBe('sonnet-5');
    expect(modelAlias('claude-opus-5')).toBe('opus-5');
    expect(modelAlias('claude-haiku-4-5-20251001')).toBe('haiku-4.5');
  });

  it('passes an unknown id through unchanged, and reads null as unknown', () => {
    expect(modelAlias('claude-fable-5')).toBe('claude-fable-5');
    expect(modelAlias(null)).toBe('unknown');
  });
});

describe('ticketFor', () => {
  it('reads the run state ticket, upper-cased', () => {
    expect(ticketFor('alpha', { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0, ticket: 'ab-1' })).toBe('AB-1');
  });

  it('falls back to the run name when it reads as a ticket key', () => {
    expect(ticketFor('ab-2', undefined)).toBe('AB-2');
  });

  it('is null for a run name that names no ticket', () => {
    expect(ticketFor('alpha', undefined)).toBeNull();
  });

  it('finds a ticket key as a whole underscore-delimited segment of a longer run name', () => {
    expect(ticketFor('jira_AB-12_1788460932645', undefined)).toBe('AB-12');
  });

  it('reads a bare ticket-shaped run name, upper-cased', () => {
    expect(ticketFor('ab-226', undefined)).toBe('AB-226');
  });

  it('is null for a hyphenated run name whose tail merely looks numbered', () => {
    expect(ticketFor('forge-live-probe-10', undefined)).toBeNull();
  });
});

describe('hopFor', () => {
  it('is hop 2 (launch), live, for a running or handed-off lane with no chain packet', () => {
    expect(hopFor(undefined, 'running', false)).toEqual({ hop: 2, hopStatus: 'live' });
    expect(hopFor(undefined, 'handed-off', false)).toEqual({ hop: 2, hopStatus: 'live' });
  });

  it('is hop 2 (launch), done, for a done/unverified/exhausted lane with no chain packet', () => {
    expect(hopFor(undefined, 'done', false)).toEqual({ hop: 2, hopStatus: 'done' });
    expect(hopFor(undefined, 'unverified', false)).toEqual({ hop: 2, hopStatus: 'done' });
    expect(hopFor(undefined, 'exhausted', false)).toEqual({ hop: 2, hopStatus: 'done' });
  });

  it('is hop 3 (gate), blocked, for a blocked lane with no chain packet', () => {
    expect(hopFor(undefined, 'blocked', false)).toEqual({ hop: 3, hopStatus: 'blocked' });
  });

  it('is hop 0 (poll), live, for a lane with no chain packet that has not started (paused/parked/killed/merged)', () => {
    expect(hopFor(undefined, 'paused', false)).toEqual({ hop: 0, hopStatus: 'live' });
    expect(hopFor(undefined, 'parked', false)).toEqual({ hop: 0, hopStatus: 'live' });
    expect(hopFor(undefined, 'killed', false)).toEqual({ hop: 0, hopStatus: 'live' });
  });

  it('reads a blocked hop name into its numeric slot, blocked', () => {
    const packet: ChainPacketState = { packetId: 'p1', blocked: { hop: 'launch', reason: 'x' } };
    expect(hopFor(packet, 'blocked', false)).toEqual({ hop: 2, hopStatus: 'blocked' });
  });

  it('is hop 4 (merge), done, once merged, unless jira writes are also complete', () => {
    const packet: ChainPacketState = { packetId: 'p1', merged: {} };
    expect(hopFor(packet, 'merged', false)).toEqual({ hop: 4, hopStatus: 'done' });
    expect(hopFor(packet, 'merged', true)).toEqual({ hop: 5, hopStatus: 'done' });
  });

  it('is hop 3 (gate), live, once launched', () => {
    const packet: ChainPacketState = { packetId: 'p1', launched: { runKey: 'alpha' } };
    expect(hopFor(packet, 'running', false)).toEqual({ hop: 3, hopStatus: 'live' });
  });

  it('is hop 2 (launch), live, once provisioned but not launched', () => {
    const packet: ChainPacketState = { packetId: 'p1', provisioned: { worktreePath: 'w', branch: 'b' } };
    expect(hopFor(packet, 'running', false)).toEqual({ hop: 2, hopStatus: 'live' });
  });
});

describe('meaningfulEvents', () => {
  const at = (event: string): { id: string; seq: number; at: number; version: 1; event: string; actor: string; run: string } => (
    { id: event, seq: 1, at: 1, version: 1, event, actor: 'runner', run: 'alpha' }
  );

  it('drops noise rows (burn.mismatch, result.usage, subagent.usage, warden.health, tool.end) when something else exists', () => {
    const events = [at('burn.mismatch'), at('run.started'), at('tool.end'), at('result.usage')];
    expect(meaningfulEvents(events).map((e) => e.event)).toEqual(['run.started']);
  });

  it('falls back to every row, noise included, when nothing else is left', () => {
    const events = [at('burn.mismatch'), at('warden.health')];
    expect(meaningfulEvents(events)).toEqual(events);
  });
});

describe('laneStateFor', () => {
  const lane = laneRecord({ slug: 'alpha', column: 'c' });

  it('running, from a started run state', () => {
    expect(laneStateFor({
      packet: undefined, lane, runEvents: [],
      runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state).toBe('running');
  });

  it('handed-off, paused and parked, from their own run states', () => {
    const of = (state: 'handed-off' | 'paused' | 'parked') => laneStateFor({
      packet: undefined, lane, runEvents: [],
      runState: { run: 'alpha', state, turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state;
    expect(of('handed-off')).toBe('handed-off');
    expect(of('paused')).toBe('paused');
    expect(of('parked')).toBe('parked');
  });

  it('done, exhausted and unverified, from a finished run state by verdict', () => {
    const of = (verdict: string | undefined) => laneStateFor({
      packet: undefined, lane, runEvents: [],
      runState: { run: 'alpha', state: 'finished', verdict, turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state;
    expect(of('done')).toBe('done');
    expect(of('exhausted')).toBe('exhausted');
    expect(of(undefined)).toBe('unverified');
  });

  it('killed, from a finished run state with a killed or skipped verdict', () => {
    const of = (verdict: string) => laneStateFor({
      packet: undefined, lane, runEvents: [],
      runState: { run: 'alpha', state: 'finished', verdict, turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state;
    expect(of('killed')).toBe('killed');
    expect(of('skipped')).toBe('killed');
  });

  it('merged, when the chain packet is merged, ahead of everything else', () => {
    const packet: ChainPacketState = { packetId: 'p1', launched: { runKey: 'alpha' }, merged: {} };
    expect(laneStateFor({
      packet, lane: { ...lane, needs_aaron: 'ignored' }, runEvents: [],
      runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state).toBe('merged');
  });

  it('blocked, with a reason, when the lane record itself carries needs_aaron', () => {
    const result = laneStateFor({ packet: undefined, lane: { ...lane, needs_aaron: 'context ceiling' }, runEvents: [], runState: undefined });
    expect(result).toEqual({ state: 'blocked', reason: 'context ceiling' });
  });

  it('blocked, with a reason, when the run\'s own last event is run.blocked', () => {
    const result = laneStateFor({
      packet: undefined, lane, runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
      runEvents: [{ id: '1', seq: 1, at: 1, version: 1, event: 'run.blocked', actor: 'runner', run: 'alpha', reason: 'base drift' }],
    });
    expect(result).toEqual({ state: 'blocked', reason: 'base drift' });
  });

  it('blocked, with a reason, when the chain packet itself is blocked', () => {
    const packet: ChainPacketState = { packetId: 'p1', blocked: { hop: 'provision', reason: 'no worktree' } };
    const result = laneStateFor({ packet, lane, runEvents: [], runState: undefined });
    expect(result).toEqual({ state: 'blocked', reason: 'no worktree' });
  });

  it('killed, when the run\'s own last event is run.killed', () => {
    const result = laneStateFor({
      packet: undefined, lane, runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, tokensUsed: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
      runEvents: [{ id: '1', seq: 1, at: 1, version: 1, event: 'run.killed', actor: 'warden', run: 'alpha', reason: 'runaway' }],
    });
    expect(result).toEqual({ state: 'killed', reason: 'runaway' });
  });

  it('falls back to the lane record\'s own verdict when the journal has nothing for this run', () => {
    expect(laneStateFor({ packet: undefined, lane: { ...lane, verdict: 'done' }, runEvents: [], runState: undefined }).state).toBe('done');
    expect(laneStateFor({ packet: undefined, lane, runEvents: [], runState: undefined }).state).toBe('unverified');
  });
});

describe('computeLanes', () => {
  it('reads model, context, cost and step text off a real journal fixture', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5', className: 'implement' });
    journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Bash' });
    journal.close();
    const fleet = replay(path);

    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const result = computeLanes(baseInput({ laneRecords: [lane], fleet, capOverrides: { alpha: 5 } }), 1_000);

    expect(result.lanes).toHaveLength(1);
    const built = result.lanes[0]!;
    expect(built.state).toBe('running');
    expect(built.model).toBe('sonnet-5');
    expect(built.modelId).toBe('claude-sonnet-5');
    expect(built.stepText).toBe('Bash');
    expect(built.ctxCeiling).toBe(200_000);
    expect(built.ctxCompactAt).toBe(180_000);
    expect(built.tokenCap).toBe(5);
  });

  it('skips noise rows (tool.end, burn.mismatch) for step text once no tool is running', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Bash' });
    journal.append({ event: 'tool.end', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'burn.mismatch', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet }), 1_000).lanes[0]!;
    expect(built.stepText).toBe('alpha running Bash');
  });

  it('counts run.blocked and engine.error rows toward fails', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.blocked', run: 'alpha', actor: 'runner', reason: 'x' });
    journal.append({ event: 'run.unblocked', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'engine.error', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet }), 1_000).lanes[0]!;
    expect(built.fails).toBe(2);
  });

  it('carries an open ask into the question field, and none when there is no run.blocked left', () => {
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const result = computeLanes(baseInput({
      laneRecords: [lane],
      openAsks: [{
        key: 'k1', question: 'staging or dev?', options: ['staging', 'dev'], kind: 'question',
        runs: ['alpha'], goals: [], asked: 1, at: 500, disposition: 'park',
      }],
    }), 1_000).lanes[0]!;
    expect(result.question).toEqual({ key: 'k1', text: 'staging or dev?', opts: ['staging', 'dev'], askedAt: 500 });
  });

  it('flags runaway for a running lane over its resolved cap', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 100_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1', className: 'implement' });
    const result = computeLanes(baseInput({ laneRecords: [lane], fleet, capOverrides: { alpha: 5 } }), 1_000).lanes[0]!;
    expect(result.state).toBe('running');
    expect(result.tokenCap).toBe(5);
    expect(result.tokens).toBeGreaterThan(5);
    expect(result.runaway).toBe(true);
  });

  it('does not flag a finished run over its cap as runaway', () => {
    const lane = { ...laneRecord({ slug: 'alpha', column: 'c1' }), cost_usd: 9, className: 'implement', verdict: 'done' };
    const result = computeLanes(baseInput({ laneRecords: [lane], capOverrides: { alpha: 5 } }), 1_000).lanes[0]!;
    expect(result.state).toBe('done');
    expect(result.tokenCap).toBe(5);
    expect(result.runaway).toBe(false);
  });

  it('sums tokensToday from every run whose last event was today', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.close();
    const fleet = replay(path);
    const result = computeLanes(baseInput({ laneRecords: [], fleet }), Date.now());
    expect(result.tokensToday).toBeGreaterThan(0);
  });
});

describe('foldChainState + computeLanes', () => {
  it('reads a merged chain packet into a merged lane, ahead of a running run state', () => {
    const events: Record<string, unknown>[] = [
      { event: 'intake.planned', actor: 'intake', packetId: 'p1', ticket: 'AB-1', repo: 'o/n', briefPath: 'AB-1.md' },
      { event: 'chain.provisioned', actor: 'chain', packetId: 'p1', worktreePath: 'w', branch: 'feature/ab-1' },
      { event: 'chain.launched', actor: 'chain', packetId: 'p1', runKey: 'alpha' },
      { event: 'chain.gated', actor: 'chain', packetId: 'p1', verdict: 'PASS' },
      { event: 'chain.merged', actor: 'chain', packetId: 'p1' },
    ];
    const chain = foldChainState(events);
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet, chain }), 1_000).lanes[0]!;
    expect(built.state).toBe('merged');
    expect(built.repo).toBe('o/n');
    expect(built.hop).toBe(4);
    expect(built.hopStatus).toBe('done');
  });
});

describe('handoff chain folding', () => {
  it('reads a finished successor as the chain lane state, never stuck at handed-off', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({ event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2' });
    journal.append({ event: 'run.started', run: 'alpha-2', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({ event: 'run.finished', run: 'alpha-2', actor: 'worker', verdict: 'done' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet }), 1_000).lanes[0]!;
    expect(built.state).toBe('done');
  });

  it('sums cost across the whole chain and reads context off the newest link', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.append({ event: 'turn.end', run: 'alpha', actor: 'runner', context: 190_000 });
    journal.append({ event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2' });
    journal.append({ event: 'run.started', run: 'alpha-2', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({
      event: 'result.usage', run: 'alpha-2', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.append({ event: 'turn.end', run: 'alpha-2', actor: 'runner', context: 42_000 });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet }), 1_000).lanes[0]!;
    expect(built.state).toBe('running');
    expect(built.ctxTokens).toBe(42_000);
    const expectedTotal = fleet.runs['alpha']!.tokensUsed + fleet.runs['alpha-2']!.tokensUsed;
    expect(built.tokens).toBe(expectedTotal);
    expect(built.tokens).toBeGreaterThan(fleet.runs['alpha-2']!.tokensUsed);
  });

  it('heart is false for a stalled handoff with no live registry row anywhere in the chain', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet, registryGet: () => undefined }), 1_000).lanes[0]!;
    expect(built.state).toBe('handed-off');
    expect(built.heart).toBe(false);
  });

  it('heart is true for a stalled handoff whose base run still has a live registry row', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1' });
    const registryRow: RegistryRecord = { goal: 'alpha', cwd: '.', briefPath: 'b.md', pid: 123, startedAt: 0 };
    const built = computeLanes(baseInput({
      laneRecords: [lane], fleet, registryGet: (run) => (run === 'alpha' ? registryRow : undefined),
    }), 1_000).lanes[0]!;
    expect(built.state).toBe('handed-off');
    expect(built.heart).toBe(true);
  });

  it('does not flag a finished chain over its cap as runaway, even before it ages off the board', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 100_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.append({ event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2' });
    journal.append({ event: 'run.started', run: 'alpha-2', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({ event: 'run.finished', run: 'alpha-2', actor: 'worker', verdict: 'unverified' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1', className: 'implement' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet }), 1_000).lanes[0]!;
    expect(built.state).toBe('unverified');
    expect(built.tokens).toBeGreaterThan(built.tokenCap ?? 0);
    expect(built.runaway).toBe(false);
  });

  it('does not flag a stalled handoff over its cap as runaway with no live registry row for it', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 100_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.append({ event: 'run.handoff', run: 'alpha', actor: 'worker', successor: 'alpha-2' });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1', className: 'implement' });
    const built = computeLanes(baseInput({ laneRecords: [lane], fleet, registryGet: () => undefined }), 1_000).lanes[0]!;
    expect(built.state).toBe('handed-off');
    expect(built.tokens).toBeGreaterThan(built.tokenCap ?? 0);
    expect(built.runaway).toBe(false);
  });
});

describe('observedAt vs the noise-refreshed RunState.lastEventAt', () => {
  it('windows a finished lane out by its own last real event, ignoring later noise the governor keeps re-emitting on every forge-up restart', () => {
    const HOUR = 3_600_000;
    const now = 100 * HOUR;
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', at: now - 30 * HOUR });
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner', verdict: 'done', at: now - 29 * HOUR });
    // `reconcileBurnOnce`'s dedup Set is per-process, so every `forge up` restart
    // re-reports the same unresolved burn mismatch once -- this run's own
    // `RunState.lastEventAt` keeps climbing to "now" even though nothing about the run
    // itself has changed since it finished a day ago.
    journal.append({ event: 'burn.mismatch', run: 'alpha', actor: 'governor', at: now - 1000 });
    journal.close();
    const fleet = replay(path);
    expect(fleet.runs['alpha']!.lastEventAt).toBe(now - 1000);
    // `started`, as every real admission sets it (`cli.ts`'s `run` command always
    // writes `Date.now()` at admission time) -- never null for a lane that has actually
    // run, which the noise-refreshed `lastEventAt` alone is enough to reopen.
    const lane = laneRecord({ slug: 'alpha', column: 'c1', started: now - 30 * HOUR });
    const result = windowLanes(computeLanes(baseInput({ laneRecords: [lane], fleet }), now), now, false);
    expect(result.lanes).toHaveLength(0);
  });

  // Triangulation against the live fleet caught a lane whose tile claimed it had been
  // observed seconds ago on every request, hours after anything happened to it: the lane
  // file carried no `started`, so the builder read the wall clock in its place and the
  // stamp renewed itself forever. A freshness stamp that cannot go stale is worse than no
  // stamp at all, so `observedAt` now comes from the newest real observation.
  it('never stamps a lane with no start time using the current clock', () => {
    const HOUR = 3_600_000;
    const now = 100 * HOUR;
    const dir = mkdtempSync(join(tmpdir(), 'lanes-noclock-'));
    const path = join(dir, 'fleet.jsonl');
    const journal = new Journal(path);
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', at: now - 40 * HOUR });
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner', at: now - 37 * HOUR });
    journal.close();
    const fleet = replay(path);
    const lane = laneRecord({ slug: 'alpha', column: 'c1', started: null });
    const [built] = computeLanes(baseInput({ laneRecords: [lane], fleet }), now).lanes;
    expect(built!.observedAt).toBe(now - 37 * HOUR);
    expect(built!.observedAt).toBeLessThan(now);
  });
});

describe('windowLanes', () => {
  const HOUR = 3_600_000;
  const now = 100 * HOUR;

  function laneWith(overrides: Partial<Lane>): Lane {
    return {
      title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
      id: 'alpha', ticket: null, model: 'sonnet-5', modelId: null, className: null, repo: null,
      attempt: 1, state: 'running', reason: null, stepN: 0, stepTotal: 0, stepText: '',
      ctxTokens: 0, ctxCeiling: 0, ctxCompactAt: 0, tokens: 0, tokenCap: null, tokensPerMin: 0,
      fails: 0, hop: 0, hopStatus: 'live', observedAt: now, verifiedAt: null, heart: true,
      since: now, startedAt: now, endedAt: null, question: null, pr: null, sandbox: null,
      blockedBy: null, runaway: false, needsAaron: null,
      ...overrides,
    };
  }

  function responseWith(lanes: Lane[]): LanesResponse {
    return { at: now, lanes, tokensToday: 0, tokensPerMin: 0 };
  }

  it('drops a finished lane whose observedAt is more than 24h old', () => {
    const stale = laneWith({ id: 'stale', state: 'done', observedAt: now - 25 * HOUR });
    const fresh = laneWith({ id: 'fresh', state: 'done', observedAt: now - 1 * HOUR });
    const result = windowLanes(responseWith([stale, fresh]), now, false);
    expect(result.lanes.map((lane) => lane.id)).toEqual(['fresh']);
  });

  it('never windows out running, handed-off, paused, parked or blocked lanes, however old', () => {
    const alwaysShown = (['running', 'handed-off', 'paused', 'parked', 'blocked'] as const).map((state, index) => (
      laneWith({ id: `lane-${index}`, state, observedAt: now - 100 * HOUR })
    ));
    const result = windowLanes(responseWith(alwaysShown), now, false);
    expect(result.lanes).toHaveLength(alwaysShown.length);
  });

  it('windows out merged, killed, exhausted and unverified lanes past 24h, same as done', () => {
    const stale = (['merged', 'killed', 'exhausted', 'unverified'] as const).map((state, index) => (
      laneWith({ id: `lane-${index}`, state, observedAt: now - 25 * HOUR })
    ));
    const result = windowLanes(responseWith(stale), now, false);
    expect(result.lanes).toHaveLength(0);
  });

  it('bypasses the window entirely when all is true', () => {
    const stale = laneWith({ id: 'stale', state: 'done', observedAt: now - 25 * HOUR });
    const result = windowLanes(responseWith([stale]), now, true);
    expect(result.lanes).toHaveLength(1);
  });

  it('leaves tokensToday and tokensPerMin untouched by the window', () => {
    const stale = laneWith({ id: 'stale', state: 'done', observedAt: now - 25 * HOUR });
    const response = { ...responseWith([stale]), tokensToday: 12.5, tokensPerMin: 0.4 };
    const result = windowLanes(response, now, false);
    expect(result.tokensToday).toBe(12.5);
    expect(result.tokensPerMin).toBe(0.4);
  });
});

describe('ticketFor: a key inside a dash-joined queue id', () => {
  it('reads BBZ-96 out of queue-BBZ-96 and its successor', () => {
    expect(ticketFor('queue-BBZ-96', undefined)).toBe('BBZ-96');
    expect(ticketFor('queue-BBZ-96-2', undefined)).toBe('BBZ-96');
  });
  it('does not mistake a lower-case probe suffix for a key', () => {
    expect(ticketFor('forge-live-probe-b3', undefined)).toBeNull();
  });
});

describe('laneKindFor', () => {
  it.each([
    ['queue-BBZ-96', 'ticket'], ['queue-brief-1788', 'brief'], ['hotfix-1788', 'hotfix'],
    ['S-1a2fccf17648f178', 'self'], ['jira_BBZ-89_1788460932645', 'chain'],
    ['forge-live-probe-b3', 'probe'], ['2026-09-04-forge-smoke-b', 'probe'], ['alpha', 'manual'],
  ])('%s is %s', (id, kind) => {
    expect(laneKindFor(id)).toBe(kind);
  });
});

describe('titleFromHeading', () => {
  it('reads the brief\'s first # heading', () => {
    expect(titleFromHeading('# Fix the login redirect\n\nmore text', null)).toBe('Fix the login redirect');
  });

  it('strips a leading "Self finding:" prefix', () => {
    expect(titleFromHeading('# Self finding: dead route\n\nbody', null)).toBe('dead route');
  });

  it('strips a leading ticket-key prefix, case-insensitively', () => {
    expect(titleFromHeading('# BBZ-96: add the merge chip\n', 'BBZ-96')).toBe('add the merge chip');
    expect(titleFromHeading('# bbz-96 add the merge chip\n', 'BBZ-96')).toBe('add the merge chip');
  });

  it('is null with no # heading at all', () => {
    expect(titleFromHeading('no heading here\njust text', null)).toBeNull();
  });

  it('is null for a heading that is only the stripped prefix', () => {
    expect(titleFromHeading('# BBZ-96\n', 'BBZ-96')).toBeNull();
  });

  it('strips a leading "Goal:" or "Goal -" prefix, ahead of the ticket-key strip', () => {
    expect(titleFromHeading('# Goal: BBZ-96: add the merge chip\n', 'BBZ-96')).toBe('add the merge chip');
    expect(titleFromHeading('# Goal - fix the withdrawal fee\n', null)).toBe('fix the withdrawal fee');
    expect(titleFromHeading('# goal:   tidy the queue worker\n', null)).toBe('tidy the queue worker');
  });

  it('falls back to the brief\'s own first paragraph when the heading is a bare kind slug (deliverable 2)', () => {
    const brief = [
      '# Self finding: health-repeat',
      '',
      'the warden has reported "stale-session" 1073 times',
      '',
      '## Evidence',
      '',
      '- a line',
    ].join('\n');
    expect(titleFromHeading(brief, null)).toBe('The warden has reported "stale-session" 1073 times');
  });

  it('recognises every observed bare kind slug, not only health-repeat', () => {
    expect(titleFromHeading('# Self finding: repeated-work\n\nthe same plan ran three times', null))
      .toBe('The same plan ran three times');
    expect(titleFromHeading('# Self finding: token-outlier\n\none run spent far more than the rest', null))
      .toBe('One run spent far more than the rest');
  });

  it('trims a long fallback paragraph to 120 characters at a word boundary', () => {
    const long = 'a '.repeat(80).trim();
    const brief = `# Self finding: health-repeat\n\n${long}\n`;
    const title = titleFromHeading(brief, null);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(120);
    expect(title!.endsWith(' ')).toBe(false);
  });
});

describe('titleFor', () => {
  it('a ticket lane titles off the brief heading and links Jira by key', () => {
    expect(titleFor({
      kind: 'ticket', ticket: 'BBZ-96', briefHeading: 'add the merge chip', jiraSite: 'https://x.atlassian.net', prUrl: null,
    })).toEqual({ title: 'add the merge chip', sourceUrl: 'https://x.atlassian.net/browse/BBZ-96' });
  });

  it('a ticket lane with no brief titles off the ticket key itself, never the run id', () => {
    expect(titleFor({
      kind: 'ticket', ticket: 'BBZ-96', briefHeading: null, jiraSite: 'https://x.atlassian.net', prUrl: null,
    })).toEqual({ title: 'BBZ-96', sourceUrl: 'https://x.atlassian.net/browse/BBZ-96' });
  });

  it('a ticket lane with no configured Jira site still titles, with no source link', () => {
    expect(titleFor({
      kind: 'ticket', ticket: 'BBZ-96', briefHeading: 'add the merge chip', jiraSite: null, prUrl: null,
    })).toEqual({ title: 'add the merge chip', sourceUrl: null });
  });

  it('a hotfix/brief lane sources to its PR, never Jira', () => {
    expect(titleFor({
      kind: 'hotfix', ticket: null, briefHeading: 'patch the crash', jiraSite: 'https://x.atlassian.net', prUrl: 'https://github.com/o/n/pull/9',
    })).toEqual({ title: 'patch the crash', sourceUrl: 'https://github.com/o/n/pull/9' });
    expect(titleFor({
      kind: 'brief', ticket: null, briefHeading: 'patch the crash', jiraSite: null, prUrl: 'https://github.com/o/n/pull/9',
    })).toEqual({ title: 'patch the crash', sourceUrl: 'https://github.com/o/n/pull/9' });
  });

  it('a self lane never sources anywhere', () => {
    expect(titleFor({ kind: 'self', ticket: null, briefHeading: 'dead route', jiraSite: 'https://x.atlassian.net', prUrl: 'https://x/pull/1' }))
      .toEqual({ title: 'dead route', sourceUrl: null });
  });

  it('a probe lane always titles the same, with no lookup needed', () => {
    expect(titleFor({ kind: 'probe', ticket: null, briefHeading: null, jiraSite: null, prUrl: null }))
      .toEqual({ title: 'Live probe of the runner', sourceUrl: null });
  });

  it('a chain lane titles off its packet brief and links Jira by key', () => {
    expect(titleFor({ kind: 'chain', ticket: 'BBZ-89', briefHeading: 'wire the merge chip', jiraSite: 'https://x.atlassian.net', prUrl: null }))
      .toEqual({ title: 'wire the merge chip', sourceUrl: 'https://x.atlassian.net/browse/BBZ-89' });
  });

  it('a manual lane titles off a registered brief when there is one, else has no title', () => {
    expect(titleFor({ kind: 'manual', ticket: null, briefHeading: 'ad-hoc CLI run', jiraSite: null, prUrl: null }))
      .toEqual({ title: 'ad-hoc CLI run', sourceUrl: null });
    expect(titleFor({ kind: 'manual', ticket: null, briefHeading: null, jiraSite: null, prUrl: null }))
      .toEqual({ title: null, sourceUrl: null });
  });
});

describe('computeLanes: attempts', () => {
  it('reports how many lanes share a ticket key, and 1 for a lane that shares with none', () => {
    const lanes = ['jira_BBZ-89_1', 'jira_BBZ-89_2', 'jira_BBZ-89_3', 'jira_BBZ-12_1'].map((slug) => laneRecord({ slug, column: slug }));
    const result = computeLanes(baseInput({ laneRecords: lanes }), 1_000);
    const byId = Object.fromEntries(result.lanes.map((lane) => [lane.id, lane.attempts]));
    expect(byId['jira_BBZ-89_1']).toBe(3);
    expect(byId['jira_BBZ-89_2']).toBe(3);
    expect(byId['jira_BBZ-89_3']).toBe(3);
    expect(byId['jira_BBZ-12_1']).toBe(1);
  });

  it('reports 1 for a lane with no ticket at all', () => {
    const lane = laneRecord({ slug: 'alpha', column: 'alpha' });
    const result = computeLanes(baseInput({ laneRecords: [lane] }), 1_000);
    expect(result.lanes[0]!.attempts).toBe(1);
  });
});

describe('mergeableFor', () => {
  const allow = (allowed: string[]) => (repo: string) => allowed.includes(repo);

  it('no PR yet', () => {
    expect(mergeableFor({ pr: null, repo: 'o/n', mergeAllowed: allow(['o/n']) }))
      .toEqual({ ok: false, why: 'no PR yet' });
  });

  it('already merged', () => {
    const pr = { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: false, merged: true, checks: 'success' as const, verdict: 'PASS' };
    expect(mergeableFor({ pr, repo: 'o/n', mergeAllowed: allow(['o/n']) })).toEqual({ ok: false, why: 'already merged' });
  });

  it('checks pending, including a card that has not read checks yet', () => {
    const pending = { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false, checks: 'pending' as const };
    expect(mergeableFor({ pr: pending, repo: 'o/n', mergeAllowed: allow(['o/n']) })).toEqual({ ok: false, why: 'checks pending' });
    const unread = { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false };
    expect(mergeableFor({ pr: unread, repo: 'o/n', mergeAllowed: allow(['o/n']) })).toEqual({ ok: false, why: 'checks pending' });
  });

  it('a draft with green checks and a clearing verdict is mergeable -- draft is never a reason', () => {
    const pr = { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false, checks: 'success' as const, verdict: 'PASS' };
    expect(mergeableFor({ pr, repo: 'o/n', mergeAllowed: allow(['o/n']) })).toEqual({ ok: true });
  });

  it('the council said FIX FIRST', () => {
    const pr = { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false, checks: 'success' as const, verdict: 'FIX FIRST' };
    expect(mergeableFor({ pr, repo: 'o/n', mergeAllowed: allow(['o/n']) })).toEqual({ ok: false, why: 'council said FIX FIRST' });
  });

  it('controlled code: the repo is not on the merge allow-list', () => {
    const pr = { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false, checks: 'success' as const, verdict: 'PASS' };
    expect(mergeableFor({ pr, repo: 'o/controlled', mergeAllowed: allow(['o/n']), controlledOwner: 'its own team' }))
      .toEqual({ ok: false, why: 'controlled code: only its own team merges this repo' });
  });

  it('PASS WITH NOTES clears the same as a bare PASS', () => {
    const pr = { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: false, merged: false, checks: 'success' as const, verdict: 'PASS WITH NOTES' };
    expect(mergeableFor({ pr, repo: 'o/n', mergeAllowed: allow(['o/n']) })).toEqual({ ok: true });
  });
});

describe('mergeReadyReportFrom', () => {
  function laneWithPr(overrides: Partial<Lane>): Lane {
    return {
      title: 'add the merge chip', kind: 'ticket', sourceUrl: null, plain: '', attempts: 1, retiredAt: null,
      id: 'queue-BBZ-96', ticket: 'BBZ-96', model: 'sonnet-5', modelId: null, className: null, repo: 'o/n',
      attempt: 1, state: 'done', reason: null, stepN: 0, stepTotal: 0, stepText: '',
      ctxTokens: 0, ctxCeiling: 0, ctxCompactAt: 0, tokens: 0, tokenCap: null, tokensPerMin: 0,
      fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: null, heart: false, since: 0,
      startedAt: 0, endedAt: null, question: null, sandbox: null, blockedBy: null, runaway: false,
      needsAaron: null, mergeable: null,
      pr: { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: true, merged: false, checks: 'success', verdict: 'PASS' },
      ...overrides,
    };
  }

  it('a lane with no PR is left out of both lists', () => {
    const lane = laneWithPr({ pr: null, mergeable: { ok: false, why: 'no PR yet' } });
    expect(mergeReadyReportFrom([lane])).toEqual({ ready: [], notReady: [] });
  });

  it('an already-merged PR is left out of both lists', () => {
    const lane = laneWithPr({ pr: { no: 1, url: 'x', files: 0, add: 0, del: 0, draft: false, merged: true }, mergeable: { ok: false, why: 'already merged' } });
    expect(mergeReadyReportFrom([lane])).toEqual({ ready: [], notReady: [] });
  });

  it('splits ready from not-ready by mergeable.ok, carrying the why', () => {
    const ready = laneWithPr({ id: 'a', mergeable: { ok: true } });
    const notReady = laneWithPr({ id: 'b', mergeable: { ok: false, why: 'checks pending' } });
    const report = mergeReadyReportFrom([ready, notReady]);
    expect(report.ready.map((r) => r.id)).toEqual(['a']);
    expect(report.notReady).toEqual([{ id: 'b', title: 'add the merge chip', pr: notReady.pr, why: 'checks pending' }]);
  });
});
