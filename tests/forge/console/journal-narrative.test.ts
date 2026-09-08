import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay, type ForgeEvent } from '../../../src/forge/journal.js';
import { foldChainState } from '../../../src/forge/chain.js';
import {
  collapseWardenChips, computeJournalNarrative, railChipText, signalPhrase,
} from '../../../src/forge/console/journal-narrative.js';
import { packetForRun } from '../../../src/forge/console/sandbox.js';
import type { Lane } from '../../../src/shared/console-model.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-journal-narrative-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'alpha', ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 1_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: true, since: 1_000,
    startedAt: 0, endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, did: null, now: '', you: null,
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
    expect(entries[0]).toEqual({ t: fleet.events[0]!.at, text: 'Polled from the queue', color: 'var(--ink2)' });
  });

  it('reports a real provisioning failure, not a simulated one', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ packetId: 'alpha', event: 'chain.blocked', hop: 'provision', reason: 'AWS sandboxes disconnected' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane(), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    expect(entries.map((e) => e.text)).toContain('Provision failed: AWS sandboxes disconnected');
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
    expect(entries.map((e) => e.text)).toContain('Sandbox provisioned');
    expect(entries.map((e) => e.text)).toContain('Branch feature/ab-1 pushed on Sonnet');
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
    expect(last).toEqual({ t: fleet.events[1]!.at, text: 'Parked; needs you', color: 'var(--park)' });
  });

  it('closes with the runaway line, priced off the lane\'s own real cost, for a still-running over-cap lane', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane({ runaway: true, fails: 3, tokens: 5_500_000 }), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    const last = entries[entries.length - 1]!;
    expect(last).toEqual({ t: 5_000, text: 'Build failing ×3; spent 5.5M tokens', color: 'var(--block)' });
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

  it('deliverable 11: reports a merge and a kill in plain words', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ packetId: 'alpha', event: 'chain.merged' });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane({ state: 'merged' }), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    expect(entries.map((e) => e.text)).toContain('Merged to main; Jira updated');
  });

  it('deliverable 11: never lets a machine id reach a narrative line', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({
      packetId: 'alpha', event: 'chain.blocked', hop: 'provision',
      reason: 'blocked behind queue-BBZ-1 at 88d44ec96baea849f7c1e8c0a1b2c3d4e5f6a7b8',
    });
    journal.close();
    const fleet = replay(path);
    const chain = foldChainState(fleet.events);
    const entries = computeJournalNarrative(lane(), fleet.events, packetForRun(chain, 'alpha'), 5_000);
    for (const entry of entries) {
      expect(entry.text).not.toMatch(/queue-|\b[0-9a-f]{40}\b/i);
    }
  });
});

function parked(overrides: Partial<ForgeEvent> & { at: number }): ForgeEvent {
  return {
    id: `x-${Math.random()}`, seq: 1, version: 1, actor: 'warden', event: 'warden.parked', ...overrides,
  } as ForgeEvent;
}

describe('collapseWardenChips (H1.9)', () => {
  it('a single row for a real lane passes through with its ordinary text', () => {
    const rows = [parked({ run: 'queue-BBZ-182', at: 1_000, signal: 'slow build' })];
    const chips = collapseWardenChips(rows);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ lane: 'queue-BBZ-182', at: 1_000 });
  });

  it('twenty repeated rows for the same lane collapse into one, with the count and the latest time', () => {
    const rows = Array.from({ length: 20 }, (_, index) => parked({
      run: 'queue-BBZ-182', at: 1_000 + index * 1_000, signal: 'stale-session',
    }));
    const chips = collapseWardenChips(rows);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.at).toBe(1_000 + 19 * 1_000);
    expect(chips[0]!.text).toContain('×20');
  });

  it('drops a bare PID row that names no real lane entirely', () => {
    const rows = Array.from({ length: 20 }, (_, index) => parked({
      run: 'PID:51340', at: 1_000 + index * 1_000, signal: 'stale-session',
    }));
    expect(collapseWardenChips(rows)).toEqual([]);
  });

  it('keeps a real lane\'s chip while dropping an unrelated bare-PID row in the same batch', () => {
    const rows = [
      parked({ run: 'PID:51340', at: 1_000, signal: 'stale-session' }),
      parked({ event: 'liveness.stuck', run: 'queue-BBZ-96', at: 2_000, signal: 'idle' }),
    ];
    const chips = collapseWardenChips(rows);
    expect(chips.map((chip) => chip.lane)).toEqual(['queue-BBZ-96']);
  });

  // Rail chip fix (2026-09-07 live-board finding): a chip must read as a sentence
  // about the lane, with its key or title, never the raw run id shouting in caps or
  // the raw signal word sitting in parens, and never a pid.
  it('phrases a context trip as a sentence naming the ticket key, never the raw run id or the bare signal word', () => {
    const rows = [parked({ event: 'liveness.stuck', run: 'queue-BBZ-99', at: 1_000, signal: 'context' })];
    const chips = collapseWardenChips(rows);
    expect(chips[0]!.text).toBe('BBZ-99: context ceiling reached, handed off to a fresh session.');
    expect(chips[0]!.text).not.toMatch(/queue-|STUCK|\(context\)/i);
  });

  it('uses the titleFor seam when the lane carries no ticket-shaped id, e.g. a probe', () => {
    const rows = [parked({ event: 'warden.parked', run: 'forge-live-probe-b', at: 1_000, signal: 'stale-session' })];
    const chips = collapseWardenChips(rows, (id) => (id === 'forge-live-probe-b' ? 'Live probe' : null));
    expect(chips[0]!.text).toBe('Live probe: parked by the warden.');
    expect(chips[0]!.text).not.toMatch(/forge-live-probe-b/i);
  });
});

describe('railChipText: label trims a long title to 60 characters (deliverable 6)', () => {
  it('trims a title over 60 characters before it reaches a chip', () => {
    const longTitle = 'a fix that touches every screen in the app and every backend endpoint too';
    const row = parked({ event: 'run.killed', run: 'alpha', at: 1_000, reason: 'over budget' });
    const text = railChipText(row, (id) => (id === 'alpha' ? longTitle : null));
    expect(text).not.toBeNull();
    const label = text!.split(' killed')[0]!;
    expect(label.length).toBeLessThanOrEqual(60);
  });
});

describe('signalPhrase (deliverable 5)', () => {
  it('is exported for the what\'s-stuck reply to reuse', () => {
    expect(signalPhrase('context')).toContain('context ceiling');
    expect(signalPhrase('idle')).toContain('quiet');
  });
});
