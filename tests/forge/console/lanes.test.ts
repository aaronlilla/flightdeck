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
  computeLanes, hopFor, laneStateFor, meaningfulEvents, modelAlias, ticketFor, type LanesInput,
} from '../../../src/forge/console/lanes.js';
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
    usdPerRun: { implement: 5 },
    capOverrides: {},
    prFor: () => null,
    usdPerHour: () => 0,
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
    expect(ticketFor('alpha', { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0, ticket: 'ab-1' })).toBe('AB-1');
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
      runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state).toBe('running');
  });

  it('handed-off, paused and parked, from their own run states', () => {
    const of = (state: 'handed-off' | 'paused' | 'parked') => laneStateFor({
      packet: undefined, lane, runEvents: [],
      runState: { run: 'alpha', state, turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state;
    expect(of('handed-off')).toBe('handed-off');
    expect(of('paused')).toBe('paused');
    expect(of('parked')).toBe('parked');
  });

  it('done, exhausted and unverified, from a finished run state by verdict', () => {
    const of = (verdict: string | undefined) => laneStateFor({
      packet: undefined, lane, runEvents: [],
      runState: { run: 'alpha', state: 'finished', verdict, turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state;
    expect(of('done')).toBe('done');
    expect(of('exhausted')).toBe('exhausted');
    expect(of(undefined)).toBe('unverified');
  });

  it('killed, from a finished run state with a killed or skipped verdict', () => {
    const of = (verdict: string) => laneStateFor({
      packet: undefined, lane, runEvents: [],
      runState: { run: 'alpha', state: 'finished', verdict, turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state;
    expect(of('killed')).toBe('killed');
    expect(of('skipped')).toBe('killed');
  });

  it('merged, when the chain packet is merged, ahead of everything else', () => {
    const packet: ChainPacketState = { packetId: 'p1', launched: { runKey: 'alpha' }, merged: {} };
    expect(laneStateFor({
      packet, lane: { ...lane, needs_aaron: 'ignored' }, runEvents: [],
      runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
    }).state).toBe('merged');
  });

  it('blocked, with a reason, when the lane record itself carries needs_aaron', () => {
    const result = laneStateFor({ packet: undefined, lane: { ...lane, needs_aaron: 'context ceiling' }, runEvents: [], runState: undefined });
    expect(result).toEqual({ state: 'blocked', reason: 'context ceiling' });
  });

  it('blocked, with a reason, when the run\'s own last event is run.blocked', () => {
    const result = laneStateFor({
      packet: undefined, lane, runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
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
      packet: undefined, lane, runState: { run: 'alpha', state: 'started', turns: 0, context: 0, costUsd: 0, lastEventAt: 0, cacheReadTokens: 0, totalReadTokens: 0, turnsSinceWrite: 0 },
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
    const result = computeLanes(baseInput({ laneRecords: [lane], fleet }), 1_000);

    expect(result.lanes).toHaveLength(1);
    const built = result.lanes[0]!;
    expect(built.state).toBe('running');
    expect(built.model).toBe('sonnet-5');
    expect(built.modelId).toBe('claude-sonnet-5');
    expect(built.stepText).toBe('Bash');
    expect(built.ctxCeiling).toBe(200_000);
    expect(built.ctxCompactAt).toBe(180_000);
    expect(built.capUsd).toBe(5);
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
    const result = computeLanes(baseInput({ laneRecords: [lane], fleet }), 1_000).lanes[0]!;
    expect(result.state).toBe('running');
    expect(result.capUsd).toBe(5);
    expect(result.costUsd).toBeGreaterThan(5);
    expect(result.runaway).toBe(true);
  });

  it('does not flag a finished run over its cap as runaway', () => {
    const lane = { ...laneRecord({ slug: 'alpha', column: 'c1' }), cost_usd: 9, className: 'implement', verdict: 'done' };
    const result = computeLanes(baseInput({ laneRecords: [lane] }), 1_000).lanes[0]!;
    expect(result.state).toBe('done');
    expect(result.capUsd).toBe(5);
    expect(result.runaway).toBe(false);
  });

  it('sums spentTodayUsd from every run whose last event was today', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'result.usage', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5',
      usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    journal.close();
    const fleet = replay(path);
    const result = computeLanes(baseInput({ laneRecords: [], fleet }), Date.now());
    expect(result.spentTodayUsd).toBeGreaterThan(0);
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
