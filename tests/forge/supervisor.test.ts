/**
 * Lane records and the breaker.
 *
 * The lane record is the contract with everything that already reads it: the old
 * dashboard, the classifier, and anyone opening a JSON file to see what a worker is
 * doing. Forge writes the fields those readers use, adds the ones the old runtime never
 * had (model, context, cost, handoff) and drops `window`, which described a terminal that
 * no longer exists. `owner: "forge"` is the field that keeps the old warden's hands off.
 *
 * The breaker is the other half of the 2026-09-03 story. A session that starts and takes
 * no turns is a failed start, and the old relaunch logic could not tell that from a
 * worker being quiet, so it relaunched forever. Three failed starts inside fifteen
 * minutes stop it and say who has to look.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  Breaker,
  clearKillSwitch,
  engageKillSwitch,
  Fleet,
  LANE_FIELDS,
  Lanes,
  laneRecord,
  readKillSwitch,
} from '../../src/forge/supervisor.js';
import { replay } from '../../src/forge/journal.js';

let dir: string;
let lanes: Lanes;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-lanes-'));
  lanes = new Lanes(join(dir, 'lanes'));
});

describe('the lane record', () => {
  it('carries every field the readers of these files expect', () => {
    const record = laneRecord({ slug: 'alpha', column: 'c' });
    for (const field of LANE_FIELDS) {
      expect(record).toHaveProperty(field);
    }
  });

  it('is owned by forge, which is what keeps the old warden off it', () => {
    expect(laneRecord({ slug: 'alpha', column: 'c' }).owner).toBe('forge');
  });

  it('carries the four fields the old runtime never had', () => {
    const record = laneRecord({
      slug: 'alpha', column: 'c', model: 'claude-sonnet-5', context: 42_000,
      cost_usd: 1.25, handoff: 'alpha-2',
    });
    expect(record.model).toBe('claude-sonnet-5');
    expect(record.context).toBe(42_000);
    expect(record.cost_usd).toBe(1.25);
    expect(record.handoff).toBe('alpha-2');
  });

  it('does not carry window, which described a terminal that no longer exists', () => {
    expect(laneRecord({ slug: 'alpha', column: 'c' })).not.toHaveProperty('window');
    expect(LANE_FIELDS).not.toContain('window');
  });

  it('writes and reads back through disk unchanged', () => {
    lanes.put('alpha', { column: 'c', model: 'claude-sonnet-5', context: 1_000 });
    const read = lanes.get('alpha');
    expect(read?.slug).toBe('alpha');
    expect(read?.model).toBe('claude-sonnet-5');
    expect(read?.owner).toBe('forge');
  });

  it('merges an update instead of replacing the record', () => {
    lanes.put('alpha', { column: 'c', session_id: 'sess-1' });
    lanes.put('alpha', { context: 90_000 });
    const read = lanes.get('alpha');
    expect(read?.session_id).toBe('sess-1');
    expect(read?.context).toBe(90_000);
  });

  it('is plain JSON a person can open', () => {
    lanes.put('alpha', { column: 'c' });
    const text = readFileSync(join(dir, 'lanes', 'alpha.json'), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain('\n');
  });

  it('lists every lane it has written', () => {
    lanes.put('alpha', { column: 'c' });
    lanes.put('beta', { column: 'd' });
    expect(lanes.all().map((row) => row.slug).sort()).toEqual(['alpha', 'beta']);
  });
});

describe('the zero-turn breaker', () => {
  let breaker: Breaker;
  const START = 1_000_000;

  beforeEach(() => {
    breaker = new Breaker(lanes);
  });

  it('lets a first failed start through', () => {
    const verdict = breaker.noteZeroTurnStart('flappy', START);
    expect(verdict.blocked).toBe(false);
    expect(verdict.count).toBe(1);
    expect(breaker.blocked('flappy')).toBe(false);
  });

  it('lets a second through', () => {
    breaker.noteZeroTurnStart('flappy', START);
    expect(breaker.noteZeroTurnStart('flappy', START + 60_000).blocked).toBe(false);
  });

  it('stops on the third inside fifteen minutes and asks for Aaron', () => {
    breaker.noteZeroTurnStart('flappy', START);
    breaker.noteZeroTurnStart('flappy', START + 60_000);
    const verdict = breaker.noteZeroTurnStart('flappy', START + 120_000);

    expect(verdict.blocked).toBe(true);
    expect(verdict.count).toBe(3);
    expect(breaker.blocked('flappy')).toBe(true);
    expect(lanes.get('flappy')?.needs_aaron).toBeTruthy();
  });

  it('never trips on starts spread wider than the window', () => {
    for (let index = 0; index < 6; index += 1) {
      const verdict = breaker.noteZeroTurnStart('slow', START + index * 1_000_000);
      expect(verdict.blocked).toBe(false);
      expect(verdict.count).toBe(1);
    }
  });

  it('counts each slug separately', () => {
    breaker.noteZeroTurnStart('one', START);
    breaker.noteZeroTurnStart('one', START + 1_000);
    breaker.noteZeroTurnStart('two', START + 2_000);
    expect(breaker.noteZeroTurnStart('two', START + 3_000).blocked).toBe(false);
  });

  it('forgets the count when a session actually does work', () => {
    breaker.noteZeroTurnStart('flappy', START);
    breaker.noteZeroTurnStart('flappy', START + 1_000);
    breaker.noteWorkingStart('flappy');
    expect(breaker.noteZeroTurnStart('flappy', START + 2_000).count).toBe(1);
  });

  it('stays blocked until somebody clears it, not until the window rolls', () => {
    breaker.noteZeroTurnStart('flappy', START);
    breaker.noteZeroTurnStart('flappy', START + 1_000);
    breaker.noteZeroTurnStart('flappy', START + 2_000);
    expect(breaker.blocked('flappy')).toBe(true);

    breaker.noteZeroTurnStart('flappy', START + 10_000_000);
    expect(breaker.blocked('flappy')).toBe(true);

    breaker.clear('flappy');
    expect(breaker.blocked('flappy')).toBe(false);
  });

  it('says in the record what a person is being asked to look at', () => {
    breaker.noteZeroTurnStart('flappy', START);
    breaker.noteZeroTurnStart('flappy', START + 1_000);
    breaker.noteZeroTurnStart('flappy', START + 2_000);
    expect(String(lanes.get('flappy')?.needs_aaron)).toMatch(/without taking a turn/i);
  });
});


describe('the kill switch', () => {
  /**
   * `forge stop --all` is the one control that has to work when nothing else does.
   * Its job is to end all spend, and to end it in a way the work survives: every run
   * parks with a handoff packet, so restarting continues rather than starting over.
   */
  it('parks every running lane', async () => {
    lanes.put('alpha', { column: 'c', session_id: 's1' });
    lanes.put('beta', { column: 'd', session_id: 's2' });
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));

    const stopped = await fleet.stopAll('kill switch');

    expect(stopped.map((row) => row.slug).sort()).toEqual(['alpha', 'beta']);
    expect(lanes.get('alpha')?.verdict).toBe('parked');
    expect(lanes.get('beta')?.verdict).toBe('parked');
  });

  it('asks each run for a handoff, so restarting continues rather than starts over', async () => {
    lanes.put('alpha', { column: 'c', session_id: 's1' });
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));
    await fleet.stopAll('kill switch');

    const state = replay(join(dir, 'fleet.jsonl'));
    const parked = state.events.filter((event) => event.event === 'run.parked');
    expect(parked).toHaveLength(1);
    expect(parked[0]?.['handoffRequested']).toBe(true);
  });

  it('journals why, so the stop is not a mystery afterwards', async () => {
    lanes.put('alpha', { column: 'c', session_id: 's1' });
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));
    await fleet.stopAll('the window is nearly spent');

    const state = replay(join(dir, 'fleet.jsonl'));
    expect(state.events.some((event) => String(event['reason'] ?? '').includes('window')))
      .toBe(true);
  });

  it('leaves a lane that had already finished alone', async () => {
    lanes.put('done', { column: 'c', verdict: 'done', ended: 1 });
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));

    expect(await fleet.stopAll('kill switch')).toHaveLength(0);
    expect(lanes.get('done')?.verdict).toBe('done');
  });

  it('is safe to run twice', async () => {
    lanes.put('alpha', { column: 'c', session_id: 's1' });
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));
    await fleet.stopAll('once');
    expect(await fleet.stopAll('twice')).toHaveLength(0);
  });

  it('reports nothing to stop rather than failing when the fleet is idle', async () => {
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));
    expect(await fleet.stopAll('kill switch')).toEqual([]);
  });

  it('counts a lane the breaker has flagged as stopped too', async () => {
    lanes.put('flappy', { column: 'c', session_id: 's1', needs_aaron: 'three bad starts' });
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));
    expect((await fleet.stopAll('kill switch')).map((row) => row.slug)).toEqual(['flappy']);
  });

  it('B.3.2: reaches a lane whose session this process holds directly', async () => {
    lanes.put('alpha', { column: 'c', session_id: 's1' });
    const sends: string[] = [];
    let stopCalls = 0;
    const live = {
      send: async (text: string) => { sends.push(text); return 'left off at src/x.ts:42'; },
      stop: async () => { stopCalls += 1; },
    };
    const fleet = new Fleet(
      lanes, join(dir, 'fleet.jsonl'), undefined, new Map([['alpha', live]]),
    );

    const stopped = await fleet.stopAll('kill switch');

    expect(sends).toHaveLength(1);
    expect(stopCalls).toBe(1);
    expect(stopped[0]?.reached).toBe(true);
    const state = replay(join(dir, 'fleet.jsonl'));
    const parked = state.events.find((event) => event.event === 'run.parked' && event.run === 'alpha');
    expect(parked?.['packet']).toBe('left off at src/x.ts:42');
  });

  it('B.3.2: marks a lane with no live session unreachable rather than silently parked', async () => {
    lanes.put('beta', { column: 'd', session_id: 's2' });
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'));

    const stopped = await fleet.stopAll('kill switch');

    expect(stopped[0]?.reached).toBe(false);
  });

  it('B.3.2: the falsifier -- a lane the code never contacted still counts as unreachable, not reached', async () => {
    lanes.put('gamma', { column: 'e', session_id: 's3' });
    const neverResponds = {
      send: () => new Promise<unknown>(() => {}),
      stop: async () => {},
    };
    const fleet = new Fleet(
      lanes, join(dir, 'fleet.jsonl'), undefined, new Map([['gamma', neverResponds]]),
    );

    const stopped = await fleet.stopAll('kill switch', 10);

    expect(stopped[0]?.reached).toBe(false);
  });

  it('code-review finding: a rejected send on one live session does not abort the rest of the loop', async () => {
    lanes.put('alpha', { column: 'c', session_id: 's1' });
    lanes.put('beta', { column: 'd', session_id: 's2' });
    const rejecting = { send: async () => { throw new Error('the subprocess is gone'); }, stop: async () => {} };
    const betaStops: string[] = [];
    const healthy = {
      send: async () => 'packet from beta',
      stop: async () => { betaStops.push('beta'); },
    };
    const fleet = new Fleet(
      lanes, join(dir, 'fleet.jsonl'), undefined,
      new Map([['alpha', rejecting], ['beta', healthy]]),
    );

    const stopped = await fleet.stopAll('kill switch');

    // Both lanes were actually looked at, not just the first one before the throw.
    expect(stopped.map((row) => row.slug).sort()).toEqual(['alpha', 'beta']);
    expect(stopped.find((row) => row.slug === 'alpha')?.reached).toBe(false);
    expect(stopped.find((row) => row.slug === 'beta')?.reached).toBe(true);
    expect(betaStops).toEqual(['beta']);
  });
});

describe('the kill switch file', () => {
  it('reads as not engaged when no file has ever been written', () => {
    expect(readKillSwitch(join(dir, 'kill-switch.json'))).toEqual({ engaged: false });
  });

  it('engages with the reason and a timestamp', () => {
    const path = join(dir, 'kill-switch.json');
    engageKillSwitch(path, 'stopped by hand');
    const state = readKillSwitch(path);
    expect(state.engaged).toBe(true);
    expect(state.reason).toBe('stopped by hand');
    expect(state.at).toBeGreaterThan(0);
  });

  it('clears back to not engaged', () => {
    const path = join(dir, 'kill-switch.json');
    engageKillSwitch(path, 'stopped by hand');
    clearKillSwitch(path);
    expect(readKillSwitch(path)).toEqual({ engaged: false });
  });

  it('Fleet.stopAll engages it, whether or not any lane was running', async () => {
    const path = join(dir, 'kill-switch.json');
    const fleet = new Fleet(lanes, join(dir, 'fleet.jsonl'), path);
    await fleet.stopAll('stopped by hand');
    expect(readKillSwitch(path).engaged).toBe(true);
  });
});
