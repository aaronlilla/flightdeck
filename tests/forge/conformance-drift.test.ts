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
import { ConformanceDrift, MIN_CALLS_TO_JUDGE, buildPrompt, extractDoD, isOnTask } from '../../src/forge/conformance-drift.js';
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

/** A full judging window: the checker declines to judge fewer calls than this. */
const WINDOW = ['Read brief.md', 'Edit src/a.ts', 'Edit src/b.ts', 'Bash: npx vitest run tests/a.test.ts', 'Bash: git commit -m x'];

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

    await checker.check('card-network-glow', '- do the thing', WINDOW);

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
    const result = await checker.check('r1', '- do the thing', WINDOW);
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

    await checker.check('r1', '- do the thing', WINDOW);
    const result = await checker.check('r1', '- do the thing', WINDOW);

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
    await checker.check('r1', '- do the thing', WINDOW);
    await checker.check('r1', '- do the thing', WINDOW);
    const third = await checker.check('r1', '- do the thing', WINDOW);
    expect(third.parked).toBe(false);
    expect(parked).toEqual([]);
  });
});

describe('too few tool calls to judge (2026-09-08: three runs parked ten minutes in)', () => {
  it('never calls the reasoner under MIN_CALLS_TO_JUDGE calls and reads as on task', async () => {
    let called = 0;
    const checker = new ConformanceDrift({
      reasoner: { provider: 'claude' as const, call: async () => { called += 1; return { text: 'no, nothing done' }; } },
      journal,
      actuator: { park: async (run) => { parked.push(run); return true; } },
    });
    const few = Array.from({ length: MIN_CALLS_TO_JUDGE - 1 }, (_, i) => `Edit src/f${i}.ts`);
    const result = await checker.check('r-young', '- [ ] everything', few);
    expect(result).toEqual({ onTask: true, parked: false, judged: false });
    expect(called).toBe(0);
    expect(parked).toEqual([]);
  });

  it('judges once the window is full', async () => {
    let called = 0;
    const checker = new ConformanceDrift({
      reasoner: { provider: 'claude' as const, call: async () => { called += 1; return { text: 'yes' }; } },
      journal,
      actuator: { park: async (run) => { parked.push(run); return true; } },
    });
    const enough = Array.from({ length: MIN_CALLS_TO_JUDGE }, (_, i) => `Edit src/f${i}.ts`);
    const result = await checker.check('r-old', '- [ ] everything', enough);
    expect(result.judged).toBe(true);
    expect(called).toBe(1);
  });
});

describe('the prompt asks whether the calls serve the brief, not whether the brief is done', () => {
  it('says unfinished work is on task and lists the calls with their targets', () => {
    const prompt = buildPrompt('- [ ] tests green', ['Read src/a.ts', 'Bash: npx vitest run tests/a.test.ts']);
    expect(prompt).toContain('Unfinished work is still on task');
    expect(prompt).toContain('not a checklist the calls must already');
    expect(prompt).toContain('- Bash: npx vitest run tests/a.test.ts');
    expect(prompt).not.toContain('(none yet)');
  });
});
