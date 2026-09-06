import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { foldChainState } from '../../../src/forge/chain.js';
import { computeJournalNarrative } from '../../../src/forge/console/journal-narrative.js';
import { packetForRun } from '../../../src/forge/console/sandbox.js';
import type { Lane } from '../../../src/shared/console-model.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-journal-narrative-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'alpha', ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 1_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, costUsd: 1, capUsd: 10, burnUsdPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: true, since: 1_000,
    startedAt: 0, endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null,
    ...extra,
  };
}

describe('computeJournalNarrative', () => {
  it('always opens with the poll line, off the run.started event', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane(), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    expect(entries[0]).toEqual({ t: fleet.events[0]!.at, text: 'polled alpha from queue', color: 'var(--ink2)' });
  });

  it('reports a real provisioning failure, not a simulated one', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ packetId: 'alpha', event: 'chain.blocked', hop: 'provision', reason: 'AWS sandboxes disconnected' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane(), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    expect(entries.map((e) => e.text)).toContain('provision failed · AWS sandboxes disconnected');
    // A run blocked on provisioning never claims a branch got pushed.
    expect(entries.some((e) => e.text.startsWith('branch'))).toBe(false);
  });

  it('adds the sandbox-provisioned and branch-pushed lines once those events land', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ packetId: 'alpha', event: 'chain.provisioned', worktreePath: 'w', branch: 'feature/ab-1' });
    journal.append({ packetId: 'alpha', event: 'chain.launched', runKey: 'alpha' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane({ sandbox: { id: 'alpha', path: 'w', branch: 'feature/ab-1', pid: 1, sessionId: null, region: 'local', instanceType: 'x' } }), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    expect(entries.map((e) => e.text)).toContain('sandbox alpha provisioned');
    expect(entries.map((e) => e.text)).toContain('branch feature/ab-1 pushed · sonnet-5');
  });

  it('closes with a state-specific line for a parked lane, off the real run.parked event', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane({ state: 'parked' }), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    const last = entries[entries.length - 1]!;
    expect(last).toEqual({ t: fleet.events[1]!.at, text: 'parked — needs human', color: 'var(--park)' });
  });

  it('closes with the runaway line, priced off the lane\'s own real cost, for a still-running over-cap lane', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane({ runaway: true, fails: 3, costUsd: 27.5 }), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    const last = entries[entries.length - 1]!;
    expect(last).toEqual({ t: 5_000, text: 'build failing ×3 · $27.50', color: 'var(--block)' });
  });

  it('adds no closing line for a lane still running normally', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane(), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    expect(entries).toHaveLength(1);
  });
});
