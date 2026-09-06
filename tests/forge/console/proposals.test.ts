import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { computeMetrics, computeProposals, generatedProposals } from '../../../src/forge/console/proposals.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-proposals-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

describe('computeMetrics', () => {
  it('counts merged today and the wait between a park and its answer', () => {
    const now = Date.now();
    const { path, journal } = tempJournal();
    journal.append({ event: 'chain.merged', actor: 'chain', packetId: 'p1' });
    journal.append({ event: 'run.parked', actor: 'runner', run: 'alpha', key: 'k1' });
    journal.close();
    const fleet = replay(path);
    // Simulate the answer two minutes after the park, for a deterministic wait.
    fleet.events.push({
      id: 'answer1', seq: 3, at: fleet.events[1]!.at + 120_000, version: 1,
      event: 'ask.answered', actor: 'operator', key: 'k1',
    });
    const metrics = computeMetrics(fleet.events, now, {});
    expect(metrics.mergedToday).toBe(1);
    expect(metrics.humanWaitMin).toBe(2);
  });

  it('adds up spend for a run whose last state today is killed, exhausted or blocked', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', actor: 'runner', run: 'alpha' });
    journal.append({ event: 'run.killed', actor: 'warden', run: 'alpha', reason: 'runaway' });
    journal.close();
    const fleet = replay(path);
    const metrics = computeMetrics(fleet.events, Date.now(), { alpha: 4.5 });
    expect(metrics.wastedUsd).toBe(4.5);
  });

  it('reads costPerMergeUsd as null with nothing merged yet', () => {
    const metrics = computeMetrics([], Date.now(), {});
    expect(metrics.costPerMergeUsd).toBeNull();
  });
});

describe('generatedProposals', () => {
  it('proposes kill-after-fails once a run reaches 3 fails today', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.blocked', actor: 'runner', run: 'alpha', reason: 'x' });
    journal.append({ event: 'run.blocked', actor: 'runner', run: 'alpha', reason: 'y' });
    journal.append({ event: 'engine.error', actor: 'runner', run: 'alpha' });
    journal.close();
    const fleet = replay(path);
    const proposals = generatedProposals(fleet.events, Date.now(), []);
    expect(proposals.some((rule) => rule.kind === 'kill-after-fails')).toBe(true);
  });

  it('never re-proposes a rule that already exists', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.blocked', actor: 'runner', run: 'alpha' });
    journal.append({ event: 'run.blocked', actor: 'runner', run: 'alpha' });
    journal.append({ event: 'run.blocked', actor: 'runner', run: 'alpha' });
    journal.close();
    const fleet = replay(path);
    const existing = [{
      id: 'kill-after-fails-alpha', kind: 'kill-after-fails', title: 't', summary: 's', evidence: 'e',
      effect: 'f', status: 'applied' as const, jid: null, prUrl: null,
    }];
    const proposals = generatedProposals(fleet.events, Date.now(), existing);
    expect(proposals.some((rule) => rule.id === 'kill-after-fails-alpha')).toBe(false);
  });
});

describe('computeProposals', () => {
  it('combines existing and generated rules with the metrics', () => {
    const result = computeProposals([], Date.now(), {}, []);
    expect(result.rules).toEqual([]);
    expect(result.metrics.mergedToday).toBe(0);
  });
});
