/**
 * Item 6 of the pipeline-hardening brief (2026-09-11): a stale liveness reading blocks
 * every relaunch until a person types a command.
 *
 * The live specimen, five times in a row on the player-card ticket:
 *   refusing to start queue-BBZ-169-Q-c578de30: run queue-BBZ-169-Q-c578de30 has
 *   produced no event for 124s; check its lane log for what it is doing
 *   run forge clear queue-BBZ-169-Q-c578de30 once you have looked at why it kept
 *   failing to start
 * The process was gone and the idle budget had since been widened, but the flag the
 * warden wrote stays on the lane until somebody clears it by hand.
 *
 * The breaker's own zero-turn-start block is deliberately NOT cleared here: that one is
 * about starts, not about a process, and `supervisor.ts` already says in writing that it
 * must not roll off on its own.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Breaker, Lanes, clearStaleBlock, clearanceForStaleBlock } from '../../src/forge/supervisor.js';

const IDLE_HINT = 'run queue-BBZ-169-Q-c578de30 has produced no event for 124s; check its lane log for what it is doing';
const ZERO_TURN_HINT = '3 starts in 15 minutes each ended without taking a turn; nothing is being relaunched until someone looks at why';

function lanes(): Lanes {
  return new Lanes(join(mkdtempSync(join(tmpdir(), 'stale-block-')), 'lanes'));
}

describe('item 6: clearanceForStaleBlock', () => {
  it('clears an idle reading whose process is gone', () => {
    expect(clearanceForStaleBlock({ reason: IDLE_HINT, runAlive: false })).toEqual({ clear: true, signal: 'idle' });
  });

  it('refuses while the process that tripped it is still alive', () => {
    const verdict = clearanceForStaleBlock({ reason: IDLE_HINT, runAlive: true });
    expect(verdict.clear).toBe(false);
    expect(verdict).toMatchObject({ why: expect.stringMatching(/still alive/i) });
  });

  it('never clears the zero-turn-start block, which is about starts and not about a process', () => {
    const verdict = clearanceForStaleBlock({ reason: ZERO_TURN_HINT, runAlive: false });
    expect(verdict.clear).toBe(false);
    expect(verdict).toMatchObject({ why: expect.stringMatching(/took no turn|starts/i) });
  });

  it('clears a tool-budget reading whose process is gone', () => {
    const hint = "run acme's Bash call has run 900s past the script command class's budget";
    expect(clearanceForStaleBlock({ reason: hint, runAlive: false })).toEqual({ clear: true, signal: 'tool-budget' });
  });

  it('refuses a reason it does not recognise rather than guessing it is stale', () => {
    const verdict = clearanceForStaleBlock({ reason: 'Aaron said stop touching this one', runAlive: false });
    expect(verdict.clear).toBe(false);
  });

  it('refuses when there is no reason at all', () => {
    expect(clearanceForStaleBlock({ reason: null, runAlive: false }).clear).toBe(false);
  });
});

describe('item 6: clearStaleBlock on a real lane', () => {
  it('hands a lane back and journals the signal it dropped', () => {
    const store = lanes();
    const breaker = new Breaker(store);
    store.put('queue-BBZ-169', { needs_aaron: IDLE_HINT });
    const rows: Record<string, unknown>[] = [];

    const verdict = clearStaleBlock('queue-BBZ-169', {
      lanes: store, breaker, runAlive: () => false, append: (row) => { rows.push(row); },
    });

    expect(verdict.clear).toBe(true);
    expect(breaker.blocked('queue-BBZ-169')).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'lane.block-cleared', run: 'queue-BBZ-169', signal: 'idle' });
    expect(String(rows[0]!['dropped'])).toContain('produced no event');
  });

  it('leaves the flag up and writes nothing when the condition still holds', () => {
    const store = lanes();
    const breaker = new Breaker(store);
    store.put('queue-BBZ-169', { needs_aaron: IDLE_HINT });
    const rows: Record<string, unknown>[] = [];

    const verdict = clearStaleBlock('queue-BBZ-169', {
      lanes: store, breaker, runAlive: () => true, append: (row) => { rows.push(row); },
    });

    expect(verdict.clear).toBe(false);
    expect(breaker.blocked('queue-BBZ-169')).toBe(true);
    expect(rows).toEqual([]);
  });

  it('is a no-op for a lane that was never blocked', () => {
    const store = lanes();
    const breaker = new Breaker(store);
    const rows: Record<string, unknown>[] = [];

    const verdict = clearStaleBlock('queue-fresh', {
      lanes: store, breaker, runAlive: () => false, append: (row) => { rows.push(row); },
    });

    expect(verdict.clear).toBe(false);
    expect(rows).toEqual([]);
  });
});
