import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Actuator, DecisionId, RunId } from '../../../src/forge/contracts.js';
import { appendOnce } from '../../../src/forge/journal.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Registry } from '../../../src/forge/registry.js';
import { ActionsLedger } from '../../../src/forge/console/actions-ledger.js';
import type { RunActionsDeps } from '../../../src/forge/console/run-actions.js';
import {
  applyRule, dismissRule, enforceRulesOnce, restoreRule, startEnforcementTick,
  type EnforcementDeps,
} from '../../../src/forge/console/rules.js';
import type { Rule } from '../../../src/shared/console-model.js';

class FakeActuator implements Actuator {
  killed: string[] = [];

  async park(): Promise<boolean> { return true; }

  async nudge(): Promise<void> {}

  async resume(): Promise<void> {}

  async kill(run: RunId, _decisionId: DecisionId): Promise<void> { this.killed.push(run); }
}

let dir: string;
let rulesFile: string;
let journalPath: string;

function writeRule(rule: Rule): void {
  writeFileSync(rulesFile, JSON.stringify({ rules: [rule] }), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-rules-'));
  rulesFile = join(dir, 'rules.json');
  journalPath = join(dir, 'fleet.jsonl');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('applyRule / dismissRule / restoreRule', () => {
  it('applies an open rule and records an undo back to dismissed', () => {
    writeRule({
      id: 'r1', kind: 'kill-after-fails', title: 'kill after fails', summary: 's', evidence: 'e',
      effect: 'kill', status: 'open', jid: null, prUrl: null,
    });
    const ledger = new ActionsLedger(join(dir, 'actions.jsonl'));

    const result = applyRule('r1', { journalPath, ledger, path: rulesFile });

    expect(result.status).toBe(200);
    const stored = JSON.parse(readFileSync(rulesFile, 'utf8'));
    expect(stored.rules[0].status).toBe('applied');
    const row = ledger.get((result.body as { jid: string }).jid);
    expect(row?.undo).toEqual({ kind: 'rule-status', payload: { id: 'r1', status: 'dismissed' } });
  });

  it('dismisses an open rule and records an undo back to open', () => {
    writeRule({
      id: 'r2', kind: 'auto-answer', title: 't', summary: 's', evidence: 'e',
      effect: 'answer', status: 'open', jid: null, prUrl: null,
    });
    const ledger = new ActionsLedger(join(dir, 'actions.jsonl'));

    const result = dismissRule('r2', { journalPath, ledger, path: rulesFile });

    expect(result.status).toBe(200);
    expect(JSON.parse(readFileSync(rulesFile, 'utf8')).rules[0].status).toBe('dismissed');
  });

  it('404s for an unknown proposal id', () => {
    writeRule({
      id: 'r1', kind: 'x', title: 't', summary: 's', evidence: 'e', effect: 'e', status: 'open',
      jid: null, prUrl: null,
    });
    const ledger = new ActionsLedger(join(dir, 'actions.jsonl'));
    const result = restoreRule('nope', { journalPath, ledger, path: rulesFile });
    expect(result.status).toBe(404);
  });
});

describe('enforceRulesOnce', () => {
  let registry: Registry;
  let actuator: FakeActuator;
  let inbox: Inbox;
  let runActions: RunActionsDeps;

  beforeEach(() => {
    registry = new Registry(join(dir, 'registry'));
    actuator = new FakeActuator();
    inbox = new Inbox(join(dir, 'inbox'));
    runActions = {
      ledger: new ActionsLedger(join(dir, 'actions.jsonl')), registry, actuator, journalPath,
      hardUsd: () => 10,
    };
  });

  it('kills a run with fails at or above the rule threshold', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', reason: 'a' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', reason: 'b' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', reason: 'c' });
    writeRule({
      id: 'r1', kind: 'kill-after-fails', title: 'kill after fails', summary: 's', evidence: 'e',
      effect: 'kill', status: 'open', jid: null, prUrl: null,
    });

    const deps: EnforcementDeps = { journalPath, rulesPath: rulesFile, inbox, runActions };
    await enforceRulesOnce(deps);

    expect(actuator.killed).toEqual(['alpha']);
  });

  it('does not kill a run below the threshold', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', reason: 'a' });
    writeRule({
      id: 'r1', kind: 'kill-after-fails', title: 't', summary: 's', evidence: 'e', effect: 'kill',
      status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    expect(actuator.killed).toEqual([]);
  });

  it('does nothing for a rule that is not open', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    writeRule({
      id: 'r1', kind: 'kill-after-fails', title: 't', summary: 's', evidence: 'e', effect: 'kill',
      status: 'dismissed', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    expect(actuator.killed).toEqual([]);
  });

  it('auto-answers an open ask matching the rule pattern', async () => {
    inbox.raise({ run: 'alpha', question: 'value cannot be NOT NULL, what now?' });
    writeRule({
      id: 'r2', kind: 'auto-answer', title: 't', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    const answered = inbox.open();
    expect(answered).toHaveLength(0);
  });
});

describe('startEnforcementTick', () => {
  it('runs the pass on the configured interval and can be stopped', async () => {
    vi.useFakeTimers();
    const registry = new Registry(join(dir, 'registry'));
    const inbox = new Inbox(join(dir, 'inbox'));
    const actuator = new FakeActuator();
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    writeRule({
      id: 'r1', kind: 'kill-after-fails', title: 't', summary: 's', evidence: 'e', effect: 'kill',
      status: 'open', jid: null, prUrl: null,
    });
    const runActions: RunActionsDeps = {
      ledger: new ActionsLedger(join(dir, 'actions.jsonl')), registry, actuator, journalPath,
      hardUsd: () => 10,
    };

    const handle = startEnforcementTick({ journalPath, rulesPath: rulesFile, inbox, runActions }, 10_000);
    expect(actuator.killed).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(actuator.killed).toEqual(['alpha']);

    handle.stop();
  });
});
