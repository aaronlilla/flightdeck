/**
 * The verdict a session gets when it ends with no forge_done, no ceiling, no park and no
 * kill. On 2026-09-14 five queue runs with no turn cap were reported "exhausted 36 turns"
 * (BBZ-303), 30 (BBZ-305), 43 (BBZ-307), 45 (BBZ-308) and 49 (BBZ-343). Nothing was
 * exhausted: each ended without finishing after its nudges ran out.
 */
import { describe, expect, it } from 'vitest';

import * as worker from '../../src/forge/worker.js';

type StopVerdict = (input: { sessions: number; turns: number; maxTurns: number | undefined }) => string;
type Describe = (slug: string, result: Record<string, unknown>) => string;

const stopVerdict = (worker as unknown as { stopVerdict: StopVerdict }).stopVerdict;
const describeResult = (worker as unknown as { describeResult: Describe }).describeResult;

describe('stopVerdict', () => {
  it('an uncapped session that stopped after working reads stopped, never exhausted', () => {
    expect(stopVerdict({ sessions: 1, turns: 49, maxTurns: undefined })).toBe('stopped');
  });

  it('a capped session that used every turn is exhausted', () => {
    expect(stopVerdict({ sessions: 1, turns: 40, maxTurns: 40 })).toBe('exhausted');
  });

  it('a capped session that stopped short of its cap is stopped', () => {
    expect(stopVerdict({ sessions: 1, turns: 12, maxTurns: 40 })).toBe('stopped');
  });

  it('a first session with no turns at all is parked', () => {
    expect(stopVerdict({ sessions: 1, turns: 0, maxTurns: undefined })).toBe('parked');
  });
});

describe('describeResult', () => {
  it('names a stop as ended without finishing after N nudges', () => {
    const line = describeResult('queue-BBZ-343-Q-11f4d980', {
      verdict: 'stopped', model: 'claude-sonnet-5', turns: 49, sessions: ['s'], handoffs: 0, nudges: 4,
    });
    expect(line).toContain('ended without finishing after 4 nudge(s)');
    expect(line).not.toMatch(/exhausted/);
  });
});
