/**
 * The Haiku conformance-drift check: two consecutive "no" verdicts park, one does not.
 * Every call here fakes the Reasoner -- no model is ever called, per this stream's
 * zero-spend rule.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replayEvents } from '../../src/forge/contracts.js';
import { ConformanceDrift, extractDoD, isOnTask } from '../../src/forge/conformance-drift.js';
import { Journal } from '../../src/forge/journal.js';

describe('extractDoD', () => {
  it('pulls the Definition of Done section verbatim, stopping at the next heading', () => {
    const brief = [
      '# Goal', '', 'Do the thing.', '',
      '## Definition of Done', '', '- item one', '- item two', '',
      '## Guardrails', '', 'never do the other thing.',
    ].join('\n');
    expect(extractDoD(brief)).toBe('- item one\n- item two');
  });

  it('is undefined when the brief declares no Definition of Done', () => {
    expect(extractDoD('# Goal\n\nDo the thing.\n')).toBeUndefined();
  });
});

describe('isOnTask', () => {
  it('is false only when the response starts with "no"', () => {
    expect(isOnTask('no, this drifted into an unrelated refactor')).toBe(false);
    expect(isOnTask('yes, still on task')).toBe(true);
    expect(isOnTask('')).toBe(true);
  });
});

let home: string;
let journalPath: string;
let journal: Journal;
let parked: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-drift-'));
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
  parked = [];
});

afterEach(() => {
  journal.close();
  rmSync(home, { recursive: true, force: true });
});

function fakeReasoner(responses: string[]) {
  let index = 0;
  return {
    provider: 'claude' as const,
    call: async () => ({ text: responses[Math.min(index++, responses.length - 1)] ?? 'yes' }),
  };
}

describe('item 7 of 2026-09-05: the reasoner call carries the run it was called for', () => {
  it('passes the run through to reasoner.call, so the journal row can attribute the spend', async () => {
    const calls: Array<{ run?: string }> = [];
    const checker = new ConformanceDrift({
      reasoner: {
        provider: 'claude' as const,
        call: async (input: { run?: string }) => {
          calls.push({ run: input.run });
          return { text: 'yes, still on task' };
        },
      },
      journal,
      actuator: { park: async (run) => { parked.push(run); return true; } },
    });

    await checker.check('card-network-glow', '- do the thing', []);

    expect(calls).toEqual([{ run: 'card-network-glow' }]);
  });
});

describe('a single off-task verdict', () => {
  it('does not park: drift needs two in a row', async () => {
    const checker = new ConformanceDrift({
      reasoner: fakeReasoner(['no, wandered off']),
      journal,
      actuator: { park: async (run) => { parked.push(run); return true; } },
    });
    const result = await checker.check('r1', '- do the thing', ['Bash: ls']);
    expect(result.parked).toBe(false);
    expect(parked).toEqual([]);
  });
});

describe('two consecutive off-task verdicts', () => {
  it('parks the run and journals warden.parked with both verdicts verbatim', async () => {
    const checker = new ConformanceDrift({
      reasoner: fakeReasoner(['no, first drift', 'no, second drift']),
      journal,
      actuator: { park: async (run) => { parked.push(run); return true; } },
    });

    await checker.check('r1', '- do the thing', []);
    const result = await checker.check('r1', '- do the thing', []);

    expect(result.parked).toBe(true);
    expect(parked).toEqual(['r1']);

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    const row = events.find((event) => event.event === 'warden.parked' && event['signal'] === 'drift');
    expect(row?.['verdicts']).toEqual(['no, first drift', 'no, second drift']);
  });

  it('an intervening yes resets the count: two more no verdicts are needed', async () => {
    const checker = new ConformanceDrift({
      reasoner: fakeReasoner(['no, drifted', 'yes, back on task', 'no, drifted again']),
      journal,
      actuator: { park: async (run) => { parked.push(run); return true; } },
    });
    await checker.check('r1', '- do the thing', []);
    await checker.check('r1', '- do the thing', []);
    const third = await checker.check('r1', '- do the thing', []);
    expect(third.parked).toBe(false);
    expect(parked).toEqual([]);
  });
});
