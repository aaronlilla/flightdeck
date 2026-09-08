import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { computeCostSteps, findCapEnforcementFailure } from '../../../src/forge/console/cost-steps.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-cost-steps-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

describe('computeCostSteps', () => {
  it('is empty for a run with no priced turns', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    expect(computeCostSteps('alpha', replay(path).events)).toEqual([]);
  });

  it('emits one row per usage-bearing turn, in order, with the raw tokens that turn used', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'turn.end', run: 'alpha', actor: 'worker', model: 'claude-sonnet-5',
      usage: { input: 1_000, cacheRead: 0, cacheCreation: 0, output: 500 },
    });
    journal.append({
      event: 'turn.end', run: 'alpha', actor: 'worker', model: 'claude-sonnet-5',
      usage: { input: 2_000, cacheRead: 0, cacheCreation: 0, output: 800 },
    });
    journal.close();
    const fleet = replay(path);
    const steps = computeCostSteps('alpha', fleet.events);

    expect(steps).toHaveLength(2);
    expect(steps[0]!.inputTokens).toBe(1_000);
    expect(steps[0]!.outputTokens).toBe(500);
    expect(steps[0]!.tokens).toBe(1_500);
    expect(steps[1]!.inputTokens).toBe(2_000);
    expect(steps[1]!.outputTokens).toBe(800);
    expect(steps[1]!.tokens).toBe(2_800);
    // No list price involved: the tokens shown here sum to the run's own real total,
    // never a dollar figure this fleet's flat subscription never actually spends.
    const total = steps.reduce((sum, s) => sum + s.tokens, 0);
    expect(total).toBe(fleet.runs['alpha']!.tokensUsed);
    expect(steps[0]!.stepText).toBe('Finished a turn');
  });

  it('deliverable 11: stepText for a reasoner call and a tool call reads in plain words, no run id', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'reasoner.call', run: 'alpha', actor: 'worker',
      usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 50 },
    });
    journal.append({
      event: 'tool.start', run: 'alpha', actor: 'worker', tool: 'Bash',
      usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 5 },
    });
    journal.close();
    const fleet = replay(path);
    const steps = computeCostSteps('alpha', fleet.events);
    expect(steps[0]!.stepText).toBe('Reasoner call');
    expect(steps[1]!.stepText).toBe('Ran Bash');
  });

  it('counts tokens for a model this policy has no price for -- unpriced is not unused', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'turn.end', run: 'alpha', actor: 'worker', model: 'claude-mystery-9',
      usage: { input: 1_000, cacheRead: 0, cacheCreation: 0, output: 500 },
    });
    journal.close();
    const fleet = replay(path);
    const steps = computeCostSteps('alpha', fleet.events);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.tokens).toBe(1_500);
  });

  it('ignores rows belonging to another run', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'turn.end', run: 'alpha', actor: 'worker', model: 'claude-sonnet-5',
      usage: { input: 1_000, cacheRead: 0, cacheCreation: 0, output: 500 },
    });
    journal.append({
      event: 'turn.end', run: 'bravo', actor: 'worker', model: 'claude-sonnet-5',
      usage: { input: 9_000, cacheRead: 0, cacheCreation: 0, output: 500 },
    });
    journal.close();
    const fleet = replay(path);
    expect(computeCostSteps('alpha', fleet.events)).toHaveLength(1);
  });
});

describe('findCapEnforcementFailure', () => {
  it('is null for a lane that is not runaway, even with an enforcement decision on record', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'decision.made', run: 'alpha', actor: 'console', action: 'rule.enforced', text: 'kill alpha' });
    journal.close();
    expect(findCapEnforcementFailure('alpha', replay(path).events, false)).toBeNull();
  });

  it('is null for a runaway lane with no enforcement decision on record', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    expect(findCapEnforcementFailure('alpha', replay(path).events, true)).toBeNull();
  });

  it('names the last enforcement decision\'s jid for a lane still runaway despite it', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'decision.made', run: 'alpha', actor: 'console', action: 'rule.enforced', text: 'kill alpha' });
    journal.close();
    const fleet = replay(path);
    const jid = findCapEnforcementFailure('alpha', fleet.events, true);
    expect(jid).toBe(`J-${fleet.events[0]!.id.slice(0, 8)}`);
  });
});
