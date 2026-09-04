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
  LANE_FIELDS,
  Lanes,
  laneRecord,
} from '../../src/forge/supervisor.js';

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
