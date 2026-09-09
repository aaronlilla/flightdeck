/**
 * The Governor (roadmap P4.2): the role that turns a planned run into a scheduled,
 * priced, bounded one.
 *
 * Every function here is pure or takes its clock and its event stream as arguments, so a
 * specimen never opens a live session, never calls a real model, and never touches a real
 * EAS build. That is what "zero-spend specimens" means for this stream.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay, type ForgeEvent } from '../../src/forge/journal.js';
import {
  accountFor,
  buildBurnLedger,
  checkBudget,
  checkConformance,
  coalesceBuilds,
  foldCodexLedger,
  isRateLimitMessage,
  reconcileBurn,
  resolveResetTime,
  WindowGate,
  type Account,
} from '../../src/forge/governor.js';
import { classFor, providerFor } from '../../src/forge/policy.js';

let dir: string;
let path: string;

function writeEvents(...rows: Partial<ForgeEvent>[]): ForgeEvent[] {
  dir = mkdtempSync(join(tmpdir(), 'forge-governor-'));
  path = join(dir, 'fleet.jsonl');
  const journal = new Journal(path);
  const written: ForgeEvent[] = [];
  for (const row of rows) written.push(journal.append(row as ForgeEvent));
  journal.close();
  return written;
}

describe('classes assigned with a provider at planning time', () => {
  it('reads a plan-class ticket as codex and an implement-class ticket as claude', () => {
    expect(providerFor('plan')).toBe('codex');
    expect(providerFor('implement')).toBe('claude');
  });

  it('is not a constant: two different classes really do read two different providers', () => {
    // The falsifier this specimen exists to catch: a provider field hardcoded to one
    // value would pass every other specimen in this file and only fail here.
    expect(providerFor('plan')).not.toBe(providerFor('implement'));
  });
});

describe('the burn ledger, keyed by run and by class', () => {
  it('sums a result.usage row per run, per class and per model id', () => {
    writeEvents(
      { event: 'run.started', run: 'r1', actor: 'runner', className: 'implement' },
      {
        event: 'result.usage', run: 'r1', actor: 'worker',
        modelUsage: {
          'claude-sonnet-5': { input: 1000, cacheRead: 0, cacheCreation: 0, output: 100, costUsd: 0.5 },
        },
      },
      { event: 'run.started', run: 'r2', actor: 'runner', className: 'research' },
      {
        event: 'result.usage', run: 'r2', actor: 'worker',
        modelUsage: {
          'claude-sonnet-5': { input: 2000, cacheRead: 0, cacheCreation: 0, output: 200, costUsd: 1.25 },
        },
      },
    );
    const ledger = buildBurnLedger(replay(path).events);
    expect(ledger.byRun['r1']).toBeCloseTo(0.5);
    expect(ledger.byRun['r2']).toBeCloseTo(1.25);
    expect(ledger.byClass['implement']).toBeCloseTo(0.5);
    expect(ledger.byClass['research']).toBeCloseTo(1.25);
    expect(ledger.byModel['claude-sonnet-5']).toBeCloseTo(1.75);
  });

  it('folds a subagent call into its parent run without double-counting it', () => {
    // The SDK's own modelUsage map on the result message already includes every Task
    // subagent, sidechain and internal call made through the query pipeline (per its own
    // doc comment) -- so one result.usage row with two model ids is a main-loop call and
    // a subagent call landing in the same run, not two runs.
    writeEvents(
      { event: 'run.started', run: 'r1', actor: 'runner', className: 'implement' },
      {
        event: 'result.usage', run: 'r1', actor: 'worker',
        modelUsage: {
          'claude-sonnet-5': { input: 1000, cacheRead: 0, cacheCreation: 0, output: 100, costUsd: 0.5 },
          'claude-haiku-4-5-20251001': { input: 500, cacheRead: 0, cacheCreation: 0, output: 50, costUsd: 0.05 },
        },
      },
    );
    const ledger = buildBurnLedger(replay(path).events);
    expect(ledger.byRun['r1']).toBeCloseTo(0.55);
    expect(ledger.byModel['claude-haiku-4-5-20251001']).toBeCloseTo(0.05);
  });

  it('flags a mismatch between the result-message sum and the per-message sum', () => {
    const events = writeEvents(
      { event: 'run.started', run: 'r1', actor: 'runner', className: 'implement', model: 'claude-sonnet-5' },
      // The per-message (B.3.6) sum: one usage event costed through policy prices.
      {
        event: 'usage', run: 'r1', actor: 'worker', model: 'claude-sonnet-5',
        usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
      },
      // The result-message sum: reports far less spend for the same run.
      {
        event: 'result.usage', run: 'r1', actor: 'worker',
        modelUsage: { 'claude-sonnet-5': { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0, costUsd: 0.10 } },
      },
    );
    void events;
    const state = replay(path);
    const ledger = buildBurnLedger(state.events);
    const mismatches = reconcileBurn(state, ledger);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.event).toBe('burn.mismatch');
    expect(mismatches[0]?.run).toBe('r1');
  });

  it('does not flag a mismatch when the two sums agree within 5 percent', () => {
    writeEvents(
      { event: 'run.started', run: 'r1', actor: 'runner', className: 'implement', model: 'claude-sonnet-5' },
      {
        event: 'usage', run: 'r1', actor: 'worker', model: 'claude-sonnet-5',
        usage: { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0 },
      },
      {
        event: 'result.usage', run: 'r1', actor: 'worker',
        modelUsage: { 'claude-sonnet-5': { input: 1_000_000, cacheRead: 0, cacheCreation: 0, output: 0, costUsd: 3.05 } },
      },
    );
    const state = replay(path);
    const ledger = buildBurnLedger(state.events);
    expect(reconcileBurn(state, ledger)).toHaveLength(0);
  });
});

describe('window pause on a rate-limit event, with a reset time', () => {
  it('recognises a rate-limit error message', () => {
    expect(isRateLimitMessage('429: rate limit exceeded, try again later')).toBe(true);
    expect(isRateLimitMessage('usage limit reached for this session')).toBe(true);
    expect(isRateLimitMessage('a tool call failed: file not found')).toBe(false);
  });

  it('parses a reset time when the message carries one, in milliseconds since the epoch', () => {
    const now = Date.parse('2026-09-04T18:00:00Z');
    const resetAt = Date.parse('2026-09-04T20:30:00Z');
    const message = `rate limit exceeded, resets at ${new Date(resetAt).toISOString()}`;
    expect(resolveResetTime(message, now)).toBe(resetAt);
  });

  it('assumes five hours from the first limit event when no reset time is in the text', () => {
    const now = Date.parse('2026-09-04T18:00:00Z');
    const resolved = resolveResetTime('rate limit exceeded', now);
    expect(resolved).toBe(now + 5 * 60 * 60 * 1000);
  });

  it('pauses every queued run of that tier and never admits one before the reset time', () => {
    const gate = new WindowGate();
    const now = Date.parse('2026-09-04T18:00:00Z');
    gate.onRateLimitEvent('sonnet', 'five_hour', 'rate limit exceeded', now);

    const beforeReset = gate.admit([{ run: 'r1', tier: 'sonnet' }], now + 60_000);
    expect(beforeReset.admitted).toHaveLength(0);
    expect(beforeReset.queued).toHaveLength(1);

    const stillBefore = gate.admit([{ run: 'r1', tier: 'sonnet' }], now + 5 * 60 * 60 * 1000 - 1);
    expect(stillBefore.admitted).toHaveLength(0);

    const afterReset = gate.admit([{ run: 'r1', tier: 'sonnet' }], now + 5 * 60 * 60 * 1000);
    expect(afterReset.admitted).toHaveLength(1);
    expect(afterReset.queued).toHaveLength(0);
  });

  it('never resumes early just because a later, unrelated event arrived', () => {
    const gate = new WindowGate();
    const now = Date.parse('2026-09-04T18:00:00Z');
    gate.onRateLimitEvent('sonnet', 'five_hour', 'rate limit exceeded', now);
    // An event on a different tier must not lift this tier's pause.
    gate.onRateLimitEvent('haiku', 'five_hour', 'rate limit exceeded', now + 30_000);
    const result = gate.admit([{ run: 'r1', tier: 'sonnet' }], now + 60_000);
    expect(result.admitted).toHaveLength(0);
  });

  it('leaves a cheap class free to run while an expensive one is paused', () => {
    const gate = new WindowGate();
    const now = Date.parse('2026-09-04T18:00:00Z');
    gate.onRateLimitEvent('opus', 'five_hour', 'rate limit exceeded', now);
    const result = gate.admit(
      [{ run: 'r1', tier: 'opus' }, { run: 'r2', tier: 'haiku' }],
      now + 60_000,
    );
    expect(result.admitted.map((entry) => entry.run)).toEqual(['r2']);
    expect(result.queued.map((entry) => entry.run)).toEqual(['r1']);
  });
});

describe('P4.8: WindowGate keyed by (account, window), never by tier alone', () => {
  it('pauses two different accounts independently: one paused account never blocks another', () => {
    const gate = new WindowGate();
    const now = Date.parse('2026-09-04T18:00:00Z');
    gate.onRateLimitEvent('test-a', 'five_hour', 'rate limit exceeded', now);
    expect(gate.isPaused('test-a', 'five_hour', now)).toBe(true);
    expect(gate.isPaused('test-b', 'five_hour', now)).toBe(false);
  });

  it('an account\'s five_hour pause never pauses its own seven_day window', () => {
    const gate = new WindowGate();
    const now = Date.parse('2026-09-04T18:00:00Z');
    gate.onRateLimitEvent('test-a', 'five_hour', 'rate limit exceeded', now);
    expect(gate.isPaused('test-a', 'five_hour', now)).toBe(true);
    expect(gate.isPaused('test-a', 'seven_day', now)).toBe(false);
  });

  it('isAccountPaused reports true when either window is paused', () => {
    const gate = new WindowGate();
    const now = Date.parse('2026-09-04T18:00:00Z');
    expect(gate.isAccountPaused('test-a', now)).toBe(false);
    gate.onRateLimitEvent('test-a', 'seven_day', 'usage limit reached', now);
    expect(gate.isAccountPaused('test-a', now)).toBe(true);
  });
});

describe('conformance per turn: message.model against the run\'s class', () => {
  it('conforms when the serving model matches the class', () => {
    const spec = classFor('implement');
    const result = checkConformance('r1', 'implement', spec.model === 'sonnet' ? 'claude-sonnet-5' : spec.model);
    expect(result.conforms).toBe(true);
    expect(result.event).toBeUndefined();
  });

  it('parks the run in the very turn a mismatch is seen, never after N turns', () => {
    const result = checkConformance('r1', 'implement', 'claude-opus-5');
    expect(result.conforms).toBe(false);
    expect(result.event?.event).toBe('warden.parked');
    expect(result.event?.run).toBe('r1');
    expect(result.event?.['expectedModel']).toBeTruthy();
    expect(result.event?.['actualModel']).toBe('claude-opus-5');
  });

  it('checks a subagent definition the same way, against its own declared class', () => {
    const conforming = checkConformance('r1', 'research', 'claude-sonnet-5');
    expect(conforming.conforms).toBe(true);
    const mismatched = checkConformance('r1', 'research', 'claude-fable-5');
    expect(mismatched.conforms).toBe(false);
  });
});

describe('nothing escalates a tier by retry', () => {
  it('assigns the same class to a run that has failed three times as to one that has not', () => {
    // There is no failure-count parameter anywhere in this module's exported surface --
    // that absence is the property under test, not an implementation detail.
    const first = checkConformance('r1', 'implement', 'claude-opus-5');
    const secondAttemptSameRun = checkConformance('r1', 'implement', 'claude-opus-5');
    const thirdAttemptSameRun = checkConformance('r1', 'implement', 'claude-opus-5');
    for (const result of [first, secondAttemptSameRun, thirdAttemptSameRun]) {
      expect(result.event?.['expectedModel']).toBe(first.event?.['expectedModel']);
    }
  });

  it('changes class only when a brief names one, never from a run\'s own history', async () => {
    const source = await import('../../src/forge/governor.js');
    const text = Object.keys(source).join(' ');
    // A defensive, explicit refusal check: the exported surface must not include any
    // function whose name suggests a failure-count-driven escalation path.
    expect(/escalat|retryTier|bumpTier|harderModel/i.test(text)).toBe(false);
  });
});

describe('EAS build coalescing, by head, platform and fingerprint', () => {
  it('merges two requests for the same head, platform and fingerprint into one build', () => {
    const groups = coalesceBuilds([
      { head: 'abc123', platform: 'android', fingerprint: 'fp1', at: 1000 },
      { head: 'abc123', platform: 'android', fingerprint: 'fp1', at: 1500 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.requests).toHaveLength(2);
  });

  it('never merges two different fingerprints on the same head and platform', () => {
    const groups = coalesceBuilds([
      { head: 'abc123', platform: 'android', fingerprint: 'fp1', at: 1000 },
      { head: 'abc123', platform: 'android', fingerprint: 'fp2', at: 1500 },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('never merges the same fingerprint on two different platforms', () => {
    const groups = coalesceBuilds([
      { head: 'abc123', platform: 'android', fingerprint: 'fp1', at: 1000 },
      { head: 'abc123', platform: 'ios', fingerprint: 'fp1', at: 1500 },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('starts a fresh build once the pending window has passed', () => {
    const groups = coalesceBuilds(
      [
        { head: 'abc123', platform: 'android', fingerprint: 'fp1', at: 0 },
        { head: 'abc123', platform: 'android', fingerprint: 'fp1', at: 120_000 },
      ],
      60_000,
    );
    expect(groups).toHaveLength(2);
  });
});

describe('budgets Aaron sets, queued against and never silently exceeded', () => {
  // `checkBudget` reads `~/.forge/console/caps.json` (FIXES-3) on top of the policy
  // file's own numbers, so every specimen here pins an empty, isolated home -- otherwise
  // a real console override on this machine would change what these assert.
  const isolatedHome = mkdtempSync(join(tmpdir(), 'governor-budget-'));

  it('allows a run under both the per-class and the daily ceiling', () => {
    const result = checkBudget('r1', 'triage', 1, 0, undefined, isolatedHome);
    expect(result.allowed).toBe(true);
  });

  it('parks a run before it starts when it would cross its class ceiling', () => {
    const result = checkBudget('r1', 'triage', 999, 0, undefined, isolatedHome);
    expect(result.allowed).toBe(false);
    expect(result.event?.event).toBe('governor.parked');
    expect(result.event?.['reason']).toBe('per-run-cap');
  });

  it('parks a run before it starts when it would cross the daily cap, even under its own ceiling', () => {
    const result = checkBudget('r1', 'triage', 1, 1_000_000, undefined, isolatedHome);
    expect(result.allowed).toBe(false);
    expect(result.event?.['reason']).toBe('daily-cap');
  });

  it('checks the spend before admitting the run, never after', () => {
    // The falsifier: a check that only logs after the money is already spent would still
    // pass a naive "was it flagged" specimen. This one insists the caller gets `allowed:
    // false` in hand before doing anything the budget would have refused.
    const decision = checkBudget('r1', 'implement-hard', 1_000_000, 0, undefined, isolatedHome);
    expect(decision.allowed).toBe(false);
    // Nothing in the result carries a `spent` acknowledgement -- there is nothing to
    // acknowledge, because nothing was spent.
    expect(decision.event?.['wouldSpendUsd']).toBe(1_000_000);
  });

  it('refuses admission at a console-overridden daily cap, not the policy one', () => {
    const home = mkdtempSync(join(tmpdir(), 'governor-budget-override-'));
    mkdirSync(join(home, 'console'), { recursive: true });
    // The policy's own daily cap easily covers this spend; only a console override
    // lowering it should be able to refuse admission here.
    writeFileSync(join(home, 'console', 'caps.json'), JSON.stringify({ dailyUsd: 2 }), 'utf8');

    const allowedAtPolicy = checkBudget('r1', 'triage', 1, 0, undefined, isolatedHome);
    expect(allowedAtPolicy.allowed).toBe(true);

    const refusedAtOverride = checkBudget('r1', 'triage', 1, 1.5, undefined, home);
    expect(refusedAtOverride.allowed).toBe(false);
    expect(refusedAtOverride.event?.['reason']).toBe('daily-cap');
    expect(refusedAtOverride.event?.['cap']).toBe(2);
  });
});

describe('accountFor: the least-utilized, non-paused account for a run', () => {
  const now = Date.parse('2026-09-04T18:00:00Z');

  function account(id: string, extra: Partial<Account> = {}): Account {
    return { id, configDir: `/accounts/${id}`, ...extra };
  }

  it('picks the account with the lowest max utilization across both windows', () => {
    const accounts = [
      account('test-a', { utilization: { five_hour: 0.8, seven_day: 0.1 } }),
      account('test-b', { utilization: { five_hour: 0.2, seven_day: 0.1 } }),
    ];
    const picked = accountFor('implement', accounts, new WindowGate(), {}, now);
    expect(picked?.id).toBe('test-b');
  });

  it('is not a constant: swapping which account is cheaper swaps the pick too', () => {
    const accounts = [
      account('test-a', { utilization: { five_hour: 0.1 } }),
      account('test-b', { utilization: { five_hour: 0.8 } }),
    ];
    // The falsifier this specimen exists to catch: a hardcoded "always test-a" would
    // pass the specimen above and only fail here.
    expect(accountFor('implement', accounts, new WindowGate(), {}, now)?.id).toBe('test-a');
  });

  it('breaks a utilization tie by fewest live runs', () => {
    const accounts = [
      account('test-a', { utilization: { five_hour: 0.3 } }),
      account('test-b', { utilization: { five_hour: 0.3 } }),
    ];
    const picked = accountFor('implement', accounts, new WindowGate(), { 'test-a': 3, 'test-b': 1 }, now);
    expect(picked?.id).toBe('test-b');
  });

  it('never picks an account paused on either rate-limit window', () => {
    const gate = new WindowGate();
    gate.onRateLimitEvent('test-a', 'five_hour', 'rate limit exceeded', now);
    const accounts = [
      account('test-a', { utilization: { five_hour: 0 } }),
      account('test-b', { utilization: { five_hour: 0.9 } }),
    ];
    // test-a is cheaper on paper but paused right now, so the busier-but-usable account wins.
    expect(accountFor('implement', accounts, gate, {}, now)?.id).toBe('test-b');
  });

  it('never picks an account explicitly paused by an operator', () => {
    const accounts = [
      account('test-a', { paused: true, utilization: { five_hour: 0 } }),
      account('test-b', { utilization: { five_hour: 0.9 } }),
    ];
    expect(accountFor('implement', accounts, new WindowGate(), {}, now)?.id).toBe('test-b');
  });

  it('falls back to undefined when every account is paused or over capacity', () => {
    const gate = new WindowGate();
    gate.onRateLimitEvent('test-a', 'five_hour', 'rate limit exceeded', now);
    gate.onRateLimitEvent('test-b', 'seven_day', 'usage limit reached', now);
    const accounts = [account('test-a'), account('test-b')];
    expect(accountFor('implement', accounts, gate, {}, now)).toBeUndefined();
  });

  it('returns undefined rather than throwing on an empty account list', () => {
    expect(accountFor('implement', [], new WindowGate(), {}, now)).toBeUndefined();
  });
});

describe('Codex\'s own ledger, separate from the fleet\'s and carrying no USD', () => {
  it('folds a stream of Codex ledger lines into a count and a total duration', () => {
    const lines = [
      JSON.stringify({ at: 1, duration_ms: 1000 }),
      JSON.stringify({ at: 2, duration_ms: 2000 }),
      '',
      'not json',
    ];
    const folded = foldCodexLedger(lines);
    expect(folded.count).toBe(2);
    expect(folded.totalDurationMs).toBe(3000);
    expect(folded).not.toHaveProperty('usd');
  });
});
