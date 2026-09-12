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
import { answeredByOf } from '../../../src/forge/intake/interviewPlanner.js';

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
    expect(rows[0]!['answeredBy']).toBe('the auto-answer rule "t"');
    expect(rows[0]!['answer']).toBe('skip nulls');
    expect(rows[0]!['itemId']).toBe('Q-abc123');
  });

  // Found by code review, 2026-09-12: the journal row was corrected but the BRIEF was
  // not. `Inbox.answer` never sets `answeredBy`, so `answeredByOf` -- which is what
  // `answersFrom` feeds into the brief's `## Decisions` -- still falls through to the
  // operator. The two records of the same event then disagree, and the worker reads a
  // heuristic's call as one Aaron made.
  it('credits the rule in the brief too, not only in the journal row', async () => {
    inbox.raise({ run: 'item:Q-abc123', ticket: 'BBZ-169', question: 'value cannot be NOT NULL, what now?' });
    writeRule({
      id: 'r3', kind: 'auto-answer', title: 't', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    const entry = inbox.all().find((row) => row.question.includes('NOT NULL'))!;
    expect(entry.answer).toBe('skip nulls');
    expect(answeredByOf(entry)).toBe('the auto-answer rule "t"');
  });

  // Edge cases neighbouring the new direct-author branch, 2026-09-12. Each is a state
  // the branch must NOT change.
  it('still credits a teammate whose attached reply the operator accepted unchanged', () => {
    inbox.raise({ run: 'item:Q-edge1', ticket: 'BBZ-1', question: 'which env?' });
    const key = inbox.open()[0]!.key;
    inbox.attachReply(key, 'joe', 'staging');
    inbox.answer(key, 'staging');
    expect(answeredByOf(inbox.entry(key)!)).toBe('joe');
  });

  it('still credits the operator when they override a teammate reply', () => {
    inbox.raise({ run: 'item:Q-edge2', ticket: 'BBZ-2', question: 'which env?' });
    const key = inbox.open()[0]!.key;
    inbox.attachReply(key, 'joe', 'staging');
    inbox.answer(key, 'production');
    expect(answeredByOf(inbox.entry(key)!)).toBe('the operator');
  });

  // Found by code review, 2026-09-12: `enforceRulesOnce` iterates every OPEN ask, and
  // an ask with a teammate's reply attached is still open on purpose -- the operator
  // confirms or changes it. A rule firing there overwrote the teammate's name on disk,
  // which is the only record that they replied at all, and left the brief crediting the
  // operator while the journal row beside it named the rule.
  it('leaves an ask alone once a teammate has replied and the operator has not confirmed', async () => {
    inbox.raise({ run: 'item:Q-pass1', ticket: 'BBZ-7', question: 'value cannot be NOT NULL, what now?' });
    const key = inbox.open()[0]!.key;
    inbox.attachReply(key, 'joe', 'use the default');
    writeRule({
      id: 'r4', kind: 'auto-answer', title: 't', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    const entry = inbox.entry(key)!;
    expect(entry.answeredBy).toBe('joe');
    expect(entry.answer).toBeUndefined();
    expect(inbox.open().map((row) => row.key)).toContain(key);
  });

  // Found by code review, 2026-09-12: the stand-down guard covered a teammate's reply
  // but not a pass still waiting for one. The pass window is hours; a rule closing it
  // drops the teammate's reply with no acknowledgement.
  it('leaves an ask alone while it is out with a teammate who has not replied', async () => {
    inbox.raise({ run: 'item:Q-pass2', ticket: 'BBZ-8', question: 'value cannot be NOT NULL, what now?' });
    const key = inbox.open()[0]!.key;
    inbox.pass(key, 'joe', Date.now(), 'thread-1');
    writeRule({
      id: 'r5', kind: 'auto-answer', title: 't', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    const entry = inbox.entry(key)!;
    expect(entry.answer).toBeUndefined();
    expect(entry.passedTo).toBe('joe');
  });

  // Found by code review, 2026-09-12: `Inbox.answer` spreads the existing entry, so a
  // prior author survived a SECOND answer. A rule closes the ask, the operator
  // disagrees and answers again through any of the four routes -- none of which passes
  // an author -- and their correction was credited to the rule.
  it('drops the previous author when the operator answers over a rule', () => {
    inbox.raise({ run: 'item:Q-again', ticket: 'BBZ-10', question: 'which env?' });
    const key = inbox.open()[0]!.key;
    inbox.answer(key, 'skip nulls', 'the auto-answer rule "t"');
    inbox.answer(key, 'production');
    expect(answeredByOf(inbox.entry(key)!)).toBe('the operator');
  });

  // Found by code review, 2026-09-12: the stand-down had no expiry. Nothing clears a
  // pass on its own, so a question passed to somebody on holiday blocked the rule on
  // every tick, forever, with no row saying why. The rule used to unblock that run.
  it('enforces once a pass has gone stale, and says so', async () => {
    inbox.raise({ run: 'item:Q-stale', ticket: 'BBZ-11', question: 'value cannot be NOT NULL, what now?' });
    const key = inbox.open()[0]!.key;
    const longAgo = Date.now() - 25 * 60 * 60 * 1000;
    inbox.pass(key, 'joe', longAgo, 'thread-old');
    writeRule({
      id: 'r7', kind: 'auto-answer', title: 't', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    expect(inbox.entry(key)!.answer).toBe('skip nulls');
    const rows = readFileSync(journalPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const overtook = rows.find((row) => row['event'] === 'decision.made'
      && String(row['text'] ?? '').includes('stale pass'));
    expect(overtook).toBeDefined();
  });

  // Found by code review, 2026-09-12: overtaking a stale hold overwrote `answeredBy`,
  // so the teammate's credit was destroyed AND `answeredByOf` fell back to the operator
  // -- the rule's call filed as Aaron's, the exact fault this branch removes.
  it('credits the rule and keeps the teammate words when it overtakes a stale reply', async () => {
    inbox.raise({ run: 'item:Q-ot', ticket: 'BBZ-13', question: 'value cannot be NOT NULL, what now?' });
    const key = inbox.open()[0]!.key;
    inbox.attachReply(key, 'joe', 'use the default');
    // Age the reply on disk. The inbox has no public way to backdate one, and the
    // window is what this specimen is about.
    const entryPath = join(dir, 'inbox', `${key}.json`);
    const aged = { ...JSON.parse(readFileSync(entryPath, 'utf8')), repliedAt: Date.now() - 25 * 60 * 60 * 1000 };
    writeFileSync(entryPath, JSON.stringify(aged), 'utf8');
    writeRule({
      id: 'r9', kind: 'auto-answer', title: 'nulls', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    const after = inbox.entry(key)!;
    expect(after.answer).toBe('skip nulls');
    expect(after.reply).toBe('use the default');
    expect(after.answeredBy).toBe('joe');
    expect(answeredByOf(after)).toBe('the auto-answer rule "nulls"');
  });

  it('still stands down while the pass is fresh', async () => {
    inbox.raise({ run: 'item:Q-fresh', ticket: 'BBZ-12', question: 'value cannot be NOT NULL, what now?' });
    const key = inbox.open()[0]!.key;
    inbox.pass(key, 'joe', Date.now(), 'thread-new');
    writeRule({
      id: 'r8', kind: 'auto-answer', title: 't', summary: 's', evidence: 'NOT NULL',
      effect: 'skip nulls', status: 'open', jid: null, prUrl: null,
    });

    await enforceRulesOnce({ journalPath, rulesPath: rulesFile, inbox, runActions });

    expect(inbox.entry(key)!.answer).toBeUndefined();
  });

  it('still credits the operator for a plain typed answer with no author', () => {
    inbox.raise({ run: 'item:Q-edge3', ticket: 'BBZ-3', question: 'which env?' });
    const key = inbox.open()[0]!.key;
    inbox.answer(key, 'staging');
    expect(answeredByOf(inbox.entry(key)!)).toBe('the operator');
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

// Found by code review, 2026-09-12: the direct-author branch survived a re-raise, so an
// operator who answered a reopened ask by hand was credited to the rule that answered
// the previous round of it.
describe('a reopened ask starts with no author', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'reopen-')); });

  it('does not credit the previous round\'s rule for a fresh operator answer', () => {
    const inbox = new Inbox(dir);
    inbox.raise({ run: 'item:Q-r1', ticket: 'BBZ-9', question: 'which env?' });
    const key = inbox.open()[0]!.key;
    inbox.answer(key, 'skip nulls', 'the auto-answer rule "t"');
    inbox.raise({ run: 'item:Q-r1', ticket: 'BBZ-9', question: 'which env?' });
    inbox.answer(key, 'production');
    expect(answeredByOf(inbox.entry(key)!)).toBe('the operator');
  });
});
