/**
 * Dispatcher decision 2: a canary applies the diff in a throwaway worktree, runs
 * `npm run verify` there, then runs the live probe brief through that worktree's
 * `forge run`. It passes only when the journal ends `done` with zero successors and
 * reproduces the golden run's decisive rows. Every dependency is a fake -- no worktree,
 * no `npm`, no SDK session is ever spawned by this specimen (zero-spend rule).
 */
import { describe, expect, it } from 'vitest';

import { asRunId, type ForgeEventEnvelope } from '../../../src/forge/contracts.js';
import { endsDoneWithNoSuccessors, matchesDecisiveRows, runCanary } from '../../../src/forge/self-iteration/canary.js';

function envelope(overrides: Partial<Omit<ForgeEventEnvelope, 'run'>> & { run?: string }): ForgeEventEnvelope {
  const { run, ...rest } = overrides;
  return {
    id: Math.random().toString(16), seq: 0, at: Date.now(), event: 'note', actor: 'test', version: 1,
    ...(run ? { run: asRunId(run) } : {}), ...rest,
  };
}

describe('endsDoneWithNoSuccessors', () => {
  it('is true when the last relevant row for the run is run.finished', () => {
    const events = [envelope({ event: 'run.started', run: 'r1' }), envelope({ event: 'run.finished', run: 'r1' })];
    expect(endsDoneWithNoSuccessors(events)).toBe(true);
  });

  it('is false when the run parks after finishing (a successor exists)', () => {
    const events = [
      envelope({ event: 'run.finished', run: 'r1' }),
      envelope({ event: 'run.parked', run: 'r1' }),
    ];
    expect(endsDoneWithNoSuccessors(events)).toBe(false);
  });

  it('is false when nothing ever finished', () => {
    expect(endsDoneWithNoSuccessors([envelope({ event: 'run.started', run: 'r1' })])).toBe(false);
  });
});

describe('matchesDecisiveRows', () => {
  it('is true when the golden events appear in order, other rows interleaved', () => {
    const events = [
      envelope({ event: 'run.started' }), envelope({ event: 'note' }), envelope({ event: 'run.finished' }),
    ];
    expect(matchesDecisiveRows(events, { decisiveEvents: ['run.started', 'run.finished'] })).toBe(true);
  });

  it('is false when a decisive row is missing', () => {
    const events = [envelope({ event: 'run.started' })];
    expect(matchesDecisiveRows(events, { decisiveEvents: ['run.started', 'run.finished'] })).toBe(false);
  });
});

describe('runCanary: fails closed at every stage', () => {
  it('fails when npm run verify does not exit 0 in the canary worktree', async () => {
    const result = await runCanary({
      applyDiffInWorktree: async () => ({ worktreeDir: 'wt' }),
      runVerify: async () => ({ exitCode: 1 }),
      runProbe: async () => { throw new Error('should never run the probe after a failed verify'); },
    }, { decisiveEvents: [] });
    expect(result.passed).toBe(false);
  });

  it('fails when the probe journal does not end done with zero successors', async () => {
    const result = await runCanary({
      applyDiffInWorktree: async () => ({ worktreeDir: 'wt' }),
      runVerify: async () => ({ exitCode: 0 }),
      runProbe: async () => ({ events: [envelope({ event: 'run.started', run: 'r1' })] }),
    }, { decisiveEvents: [] });
    expect(result.passed).toBe(false);
  });

  it('fails when the probe misses a golden decisive row even though it ends done', async () => {
    const result = await runCanary({
      applyDiffInWorktree: async () => ({ worktreeDir: 'wt' }),
      runVerify: async () => ({ exitCode: 0 }),
      runProbe: async () => ({ events: [envelope({ event: 'run.finished', run: 'r1' })] }),
    }, { decisiveEvents: ['forge.ask', 'run.finished'] });
    expect(result.passed).toBe(false);
  });

  it('passes when verify is green, the journal ends done, and every decisive row is present', async () => {
    const result = await runCanary({
      applyDiffInWorktree: async () => ({ worktreeDir: 'wt' }),
      runVerify: async () => ({ exitCode: 0 }),
      runProbe: async () => ({
        events: [envelope({ event: 'forge.ask', run: 'r1' }), envelope({ event: 'run.finished', run: 'r1' })],
      }),
    }, { decisiveEvents: ['forge.ask', 'run.finished'] });
    expect(result.passed).toBe(true);
  });
});
