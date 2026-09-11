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
      hardTokens: () => 10,
    };
  });

  it('kills a run with fails at or above the rule threshold', async () => {
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    // Still running despite three fails today -- killRun's own state guard refuses a
    // kill on a run that is already blocked, so each fail is followed by an unblock.
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', reason: 'a' });
    appendOnce(journalPath, { event: 'run.unblocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', reason: 'b' });
    appendOnce(journalPath, { event: 'run.unblocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha', reason: 'c' });
    appendOnce(journalPath, { event: 'run.unblocked', run: 'alpha' });
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

  // Found by code review, 2026-09-11: the rule's answer was journalled as the operator's,
  // because `answeredByOf` falls through to the operator whenever `answeredBy` is unset.
  // A rule answered, not Aaron, and the `decision.made` row beside it already says so.
  it('credits the rule, not the operator, when an auto-answer closes an interview ask', async () => {
    inbox.raise({ run: 'item:Q-abc123', ticket: 'BBZ-169', question: 'value cannot be NOT NULL, what now?' });
    writeRule({
      id: 'r2', kind: 'auto-answer', title: 't', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    const rows = readFileSync(journalPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row['event'] === 'interview.answered');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['answeredBy']).toBe('rule:r2');
    expect(rows[0]!['answer']).toBe('skip nulls');
    expect(rows[0]!['itemId']).toBe('Q-abc123');
  });
});

describe('startEnforcementTick', () => {
  it('runs the pass on the configured interval and can be stopped', async () => {
    vi.useFakeTimers();
    const registry = new Registry(join(dir, 'registry'));
    const inbox = new Inbox(join(dir, 'inbox'));
    const actuator = new FakeActuator();
    registry.admit({ goal: 'alpha', cwd: dir, briefPath: join(dir, 'alpha.md'), pid: process.pid });
    // Still running despite three fails today -- killRun's own state guard refuses a
    // kill on a run that is already blocked, so each fail is followed by an unblock.
    appendOnce(journalPath, { event: 'run.started', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.unblocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.unblocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.blocked', run: 'alpha' });
    appendOnce(journalPath, { event: 'run.unblocked', run: 'alpha' });
    writeRule({
      id: 'r1', kind: 'kill-after-fails', title: 't', summary: 's', evidence: 'e', effect: 'kill',
      status: 'open', jid: null, prUrl: null,
    });
    const runActions: RunActionsDeps = {
      ledger: new ActionsLedger(join(dir, 'actions.jsonl')), registry, actuator, journalPath,
      hardTokens: () => 10,
    };

    const handle = startEnforcementTick({ journalPath, rulesPath: rulesFile, inbox, runActions }, 10_000);
    expect(actuator.killed).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(actuator.killed).toEqual(['alpha']);

    handle.stop();
  });
});
