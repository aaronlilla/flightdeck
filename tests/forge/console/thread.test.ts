import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { computeRunThread, computeThread } from '../../../src/forge/console/thread.js';
import type { InboxEntry } from '../../../src/forge/inbox.js';
import type { Message } from '../../../src/shared/console-model.js';

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-thread-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

describe('computeThread', () => {
  it('merges persisted rail messages with system chips for matching journal rows', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Bash' });
    journal.close();
    const fleet = replay(path);

    const persisted: Message[] = [
      { k: 'm1', type: 'operator', text: 'pause everything', ts: 1, source: 'operator' },
    ];
    const result = computeThread(persisted, fleet.events, 10_000);
    const kinds = result.messages.map((m) => m.type);
    expect(kinds).toContain('operator');
    expect(kinds).toContain('event');
    // tool.start is not a chip-worthy event: only run.parked shows up as a chip.
    expect(result.messages.filter((m) => m.type === 'event')).toHaveLength(1);
  });

  it('H1.9: collapses a repeated warden.parked storm for one real lane into a single chip', () => {
    const { path, journal } = tempJournal();
    for (let i = 0; i < 20; i += 1) {
      journal.append({ event: 'warden.parked', run: 'queue-BBZ-182', actor: 'warden', signal: 'stale-session' });
    }
    journal.close();
    const fleet = replay(path);

    const result = computeThread([], fleet.events, 10_000);
    const eventMessages = result.messages.filter((m) => m.type === 'event');
    expect(eventMessages).toHaveLength(1);
    expect(eventMessages[0]!.text).toContain('×20');
  });

  // Rail chip fix (2026-09-07 live-board finding): "FORGE-LIVE-PROBE-B PARKED ON
  // e047516204ee5d00" -- a run.parked chip must never print the ask key, and should
  // use the titleFor seam rather than the raw run id.
  it('phrases a run.parked chip with the lane\'s title and never the ask key', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.parked', run: 'forge-live-probe-b', actor: 'runner', key: 'e047516204ee5d00' });
    journal.close();
    const fleet = replay(path);

    const result = computeThread([], fleet.events, 10_000, [], (id) => (id === 'forge-live-probe-b' ? 'Live probe' : null));
    const chip = result.messages.find((m) => m.type === 'event');
    expect(chip?.text).toBe('Live probe parked, waiting on you.');
    expect(chip?.text).not.toMatch(/e047516204ee5d00|forge-live-probe-b/i);
  });

  it('H1.9: never puts a bare-PID stuck-session row on the rail at all', () => {
    const { path, journal } = tempJournal();
    for (let i = 0; i < 5; i += 1) {
      journal.append({ event: 'warden.parked', run: 'PID:51340', actor: 'warden', signal: 'stale-session' });
    }
    journal.close();
    const fleet = replay(path);

    const result = computeThread([], fleet.events, 10_000);
    expect(result.messages.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('shows no chips for an event before the earliest persisted message', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);
    fleet.events[0]!.at = 0;

    const persisted: Message[] = [{ k: 'm1', type: 'operator', text: 'hi', ts: 5_000, source: 'operator' }];
    const result = computeThread(persisted, fleet.events, 10_000);
    expect(result.messages.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('surfaces a run\'s open inbox ask as an answerable question card, not just a plate', () => {
    // The board's needs-you plate and the rail's "Question" card (with clickable option
    // buttons) read from two different places: the plate reads `lane.question` off
    // /lanes, but the rail's card only ever renders a persisted `type: 'question'`
    // message -- and nothing wrote one for a live parked run. An operator staring at
    // the rail saw no way to click an answer; they had to already know to type
    // `answer <key> <text>` into the composer by hand.
    const entry: InboxEntry = {
      key: 'ask-1', question: 'Probe: continue to the end?', options: ['Yes', 'No'],
      kind: 'question', runs: ['probe-1'], goals: ['probe-1'], asked: 1, at: 2_000,
      disposition: 'park',
    };
    const result = computeThread([], [], 10_000, [entry]);
    const question = result.messages.find((m) => m.type === 'question');
    expect(question).toBeDefined();
    expect(question?.askKey).toBe('ask-1');
    expect(question?.opts).toEqual(['Yes', 'No']);
    expect(question?.text).toBe('Probe: continue to the end?');
  });
});

describe('computeThread: plain mode (deliverable 8)', () => {
  it('humanizes a persisted operator command through commandEcho', () => {
    const persisted: Message[] = [
      { k: 'm1', type: 'operator', text: 'kill S-b9d39bae548707e0', ts: 1, source: 'operator' },
    ];
    const result = computeThread(persisted, [], 10_000, [], (id) => (id === 'S-b9d39bae548707e0' ? 'health-repeat' : null));
    const operator = result.messages.find((m) => m.type === 'operator');
    expect(operator?.text).toBe('Kill health-repeat.');
  });

  it('humanizes a persisted receipt through receiptText, naming the question off the full inbox', () => {
    const persisted: Message[] = [
      { k: 'm1', type: 'receipt', text: 'answered f92af4249f6a27ae: Restart', ts: 1, source: 'operator' },
    ];
    const allAsks: InboxEntry[] = [{
      key: 'f92af4249f6a27ae', question: 'Restart the forge MCP connection?', options: [], kind: 'question',
      runs: ['probe-1'], goals: [], asked: 1, at: 1, disposition: 'park', answer: 'Restart', answeredAt: 2,
    }];
    const result = computeThread(persisted, [], 10_000, [], () => null, { allAsks });
    const receipt = result.messages.find((m) => m.type === 'receipt');
    expect(receipt?.text).toBe('Answered "Restart the forge MCP connection?": Restart');
  });

  it('strips machine ids out of reply and refusal text', () => {
    const persisted: Message[] = [
      { k: 'm1', type: 'reply', text: 'S-b9d39bae548707e0 is stuck', ts: 1, source: 'system' },
      { k: 'm2', type: 'refusal', text: 'no lane matches jira_BBZ-1_1788543015139', ts: 2, source: 'system' },
    ];
    const result = computeThread(persisted, [], 10_000);
    const reply = result.messages.find((m) => m.type === 'reply');
    const refusal = result.messages.find((m) => m.type === 'refusal');
    expect(reply?.text).not.toMatch(/S-[0-9a-f]{12,}/);
    expect(refusal?.text).not.toMatch(/jira_/);
  });

  it('keeps jid on a receipt message; the client hides it, plain mode never drops it', () => {
    const persisted: Message[] = [
      { k: 'm1', type: 'receipt', text: 'answered f92af4249f6a27ae', ts: 1, source: 'operator', jid: 'J-abc12345' },
    ];
    const result = computeThread(persisted, [], 10_000);
    const receipt = result.messages.find((m) => m.type === 'receipt');
    expect(receipt?.jid).toBe('J-abc12345');
  });

  it('verbose: leaves persisted rows exactly as stored', () => {
    const persisted: Message[] = [
      { k: 'm1', type: 'operator', text: 'kill S-b9d39bae548707e0', ts: 1, source: 'operator' },
    ];
    const result = computeThread(persisted, [], 10_000, [], () => null, { verbose: true });
    const operator = result.messages.find((m) => m.type === 'operator');
    expect(operator?.text).toBe('kill S-b9d39bae548707e0');
  });
});

describe('computeRunThread', () => {
  it('verbose: renders a run\'s own journal rows as messages, merged with its run-inbox sends', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, [
      { id: 'm1', at: 5, seq: 0, from: 'console', text: 'do the thing' },
    ], { verbose: true });
    expect(result.messages.map((m) => m.text)).toContain('alpha started');
    expect(result.messages.map((m) => m.text)).toContain('do the thing');
  });

  it('renders forge.report as a reply card carrying the run\'s own outcome text', () => {
    const { path, journal } = tempJournal();
    journal.append({
      event: 'forge.report', run: 'alpha', actor: 'worker',
      outcome: 'shipped the fix', done: 'tests pass', leftOff: 'nothing outstanding',
    });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);

    const report = result.messages.find((m) => m.text.includes('shipped the fix'));
    expect(report).toBeDefined();
    expect(report!.type).toBe('reply');
    expect(report!.source).toBe('alpha');
    expect(report!.text).toContain('Done: tests pass');
    expect(report!.text).toContain('Left off: nothing outstanding');
  });

  it('renders forge.done as a reply card carrying its evidence text', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'forge.done', run: 'alpha', actor: 'worker', evidence: 'ran the test suite, green' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);

    const done = result.messages.find((m) => m.text === 'ran the test suite, green');
    expect(done).toBeDefined();
    expect(done!.type).toBe('reply');
    expect(done!.source).toBe('alpha');
  });

  it('renders the run\'s own decision.made rows as receipt cards carrying their jid', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'decision.made', run: 'alpha', actor: 'console', action: 'kill', text: 'kill requested: over budget' });
    journal.close();
    const fleet = replay(path);
    const row = fleet.events[0]!;

    const result = computeRunThread('alpha', fleet.events, []);

    const receipt = result.messages.find((m) => m.type === 'receipt');
    expect(receipt).toBeDefined();
    expect(receipt!.jid).toBe(`J-${row.id.slice(0, 8)}`);
  });
});

describe('computeRunThread: plain mode (deliverable 7)', () => {
  it('run.started reads as a sentence naming the model, when the row carries one', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner', model: 'claude-sonnet-5-20260101' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    expect(result.messages.map((m) => m.text)).toContain(
      `Started on Sonnet at ${new Date(fleet.events[0]!.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    );
  });

  it('run.started omits the model clause when the row carries none', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    expect(result.messages.map((m) => m.text)).toContain(
      `Started at ${new Date(fleet.events[0]!.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    );
  });

  it('folds a burst of tool calls into one activity message, counted by category', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    for (let i = 0; i < 3; i += 1) {
      journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Bash' });
      journal.append({ event: 'tool.end', run: 'alpha', actor: 'runner' });
    }
    journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Read' });
    journal.append({ event: 'tool.end', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner', verdict: 'done' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    const activity = result.messages.find((m) => m.type === 'activity');
    expect(activity).toBeDefined();
    expect(activity!.text).toContain('3 commands');
    expect(activity!.text).toContain('1 file read');
    expect(activity!.text).toMatch(/^Worked \d{1,2}:\d{2}.*\s+to\s+\d{1,2}:\d{2}/i);
  });

  it('a burst with exactly one counted call reads as a single sentence, not a range', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'tool.start', run: 'alpha', actor: 'runner', tool: 'Bash' });
    journal.append({ event: 'tool.end', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner', verdict: 'done' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    const activity = result.messages.find((m) => m.type === 'activity');
    expect(activity!.text).toMatch(/^Ran 1 command at \d{1,2}:\d{2}/i);
  });

  it('collapses two consecutive replies that share their first 80 characters, marking the newest', () => {
    const { path, journal } = tempJournal();
    const longOutcome = 'the run got stuck on the same step and reported the exact same outcome text twice over';
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'forge.report', run: 'alpha', actor: 'worker', outcome: longOutcome });
    journal.append({ event: 'run.relaunched', run: 'alpha', actor: 'runner', attempt: 2 });
    journal.append({ event: 'forge.report', run: 'alpha', actor: 'worker', outcome: longOutcome });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    const replies = result.messages.filter((m) => m.type === 'reply');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain('(repeated after a relaunch)');
  });

  it('maps forge.ask, ask.answered, park/resume/relaunch/kill/finish/handoff to plain sentences', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'forge.ask', run: 'alpha', actor: 'worker', question: 'dev or staging?' });
    journal.append({ event: 'ask.answered', run: 'alpha', actor: 'operator', answer: 'dev' });
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner', reason: 'waiting on you' });
    journal.append({ event: 'run.resumed', run: 'alpha', actor: 'operator' });
    journal.append({ event: 'run.relaunched', run: 'alpha', actor: 'runner', attempt: 2 });
    journal.append({ event: 'run.killed', run: 'alpha', actor: 'operator', reason: 'over budget' });
    journal.append({ event: 'run.finished', run: 'alpha', actor: 'runner', verdict: 'killed' });
    journal.append({ event: 'run.handoff', run: 'alpha', actor: 'runner', successor: 'alpha-2' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    const texts = result.messages.map((m) => m.text);
    expect(texts).toContain('Asked you: dev or staging?');
    expect(texts).toContain('You answered: dev');
    expect(texts).toContain('Parked: waiting on you');
    expect(texts).toContain('Resumed');
    expect(texts).toContain('Relaunched (attempt 2)');
    expect(texts).toContain('Killed: over budget');
    expect(texts).toContain('Finished: killed');
    expect(texts).toContain('Context ceiling reached; handed off to a fresh session');
  });

  it('drops a permission.denied row that carries no reason, keeps one that does', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'permission.denied', run: 'alpha', actor: 'runner', tool: 'Bash' });
    journal.append({ event: 'permission.denied', run: 'alpha', actor: 'runner', tool: 'Bash', reason: 'not allowed' });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    const denials = result.messages.filter((m) => m.text.includes('Asked to use'));
    expect(denials).toHaveLength(1);
    expect(denials[0]!.text).toBe('Asked to use Bash; parked instead');
  });

  it('never lets a machine id reach a plain message, over a wide sweep of event kinds', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'run.started', run: 'alpha', actor: 'runner' });
    journal.append({ event: 'run.parked', run: 'alpha', actor: 'runner', reason: 'parking on a1b2c3d4e5f6a7b8: continue?' });
    journal.append({ event: 'warden.parked', run: 'alpha', actor: 'warden', reason: 'stale-session for jira_BBZ-99_1788543015139' });
    journal.append({
      event: 'run.killed', run: 'alpha', actor: 'operator',
      reason: 'blocked behind queue-BBZ-1 at 88d44ec96baea849f7c1e8c0a1b2c3d4e5f6a7b8',
    });
    journal.close();
    const fleet = replay(path);

    const result = computeRunThread('alpha', fleet.events, []);
    const idPattern = /S-[0-9a-f]{12,}|jira_|queue-|\b[0-9a-f]{40}\b|\b[0-9a-f]{16,39}\b/i;
    for (const message of result.messages) {
      expect(message.text).not.toMatch(idPattern);
    }
  });
});
