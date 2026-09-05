/**
 * Questions a worker asks, and the answers that come back.
 *
 * A worker running unattended cannot block on a prompt: the old runtime's sessions sat at
 * an AskUserQuestion nobody could see, taking no more tool calls, so the inbox that was
 * supposed to reach them never could. Here the question is intercepted before it renders,
 * written to `.forge/inbox`, and the run parks with its work committed and its lane
 * released. An answer file resumes it.
 *
 * The row that matters is the dedup. A worker that asks the same thing twice, or two
 * workers that hit the same wall, must produce one entry: an inbox that grows a line per
 * retry is an inbox nobody reads, which is the same as no inbox.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Inbox, askKey } from '../../src/forge/inbox.js';

let dir: string;
let inbox: Inbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-inbox-'));
  inbox = new Inbox(join(dir, '.forge', 'inbox'));
});

const QUESTION = {
  run: 'alpha',
  question: 'Which environment should the migration target?',
  options: ['dev', 'staging'],
};

describe('raising a question', () => {
  it('writes one entry', () => {
    const entry = inbox.raise(QUESTION);
    expect(entry.key).toBeTruthy();
    expect(inbox.open()).toHaveLength(1);
  });

  it('writes one entry for two identical asks', () => {
    const first = inbox.raise(QUESTION);
    const second = inbox.raise({ ...QUESTION });

    expect(second.key).toBe(first.key);
    expect(inbox.open()).toHaveLength(1);
    expect(readdirSync(join(dir, '.forge', 'inbox'))).toHaveLength(1);
  });

  it('counts the repeat rather than losing it', () => {
    inbox.raise(QUESTION);
    const second = inbox.raise({ ...QUESTION });
    expect(second.asked).toBe(2);
  });

  it('treats a different question as a different entry', () => {
    inbox.raise(QUESTION);
    inbox.raise({ ...QUESTION, question: 'Which operator is this for?' });
    expect(inbox.open()).toHaveLength(2);
  });

  it('B.3.7: the same question from another run is a different wall', () => {
    // Reversed from the pre-B.3.7 design ("two runs blocked on one decision is one
    // decision to make"): a successor after a handoff is a different run asking the same
    // words, and merging it with whatever the predecessor already asked would hide that
    // it happened again. The key now scopes by run (and goal, and action target)
    // alongside wording, so two runs asking identically get two keys.
    expect(askKey({ ...QUESTION, run: 'alpha' }))
      .not.toBe(askKey({ ...QUESTION, run: 'beta' }));
  });

  it('B.3.7: the same run asking the same words twice is still one wall', () => {
    expect(askKey({ ...QUESTION, run: 'alpha' }))
      .toBe(askKey({ ...QUESTION, run: 'alpha' }));
  });

  it('code-review finding: a blocker keeps the pre-B.3.7 cross-run merge, unlike a question', () => {
    // driftBlocker (drift.ts) never sets goal or actionTarget and relies on every run
    // behind the same base sharing one key, one answer releasing all of them. The B.3.7
    // scoping above is for question/forge_ask asks specifically, not blockers.
    const blocker = { ...QUESTION, kind: 'blocker' as const };
    expect(askKey({ ...blocker, run: 'alpha' })).toBe(askKey({ ...blocker, run: 'beta' }));
  });

  it('is unmoved by whitespace and case in the wording', () => {
    expect(askKey(QUESTION))
      .toBe(askKey({ ...QUESTION, question: '  which ENVIRONMENT should the migration target?  ' }));
  });

  it('does not merge two questions that differ only in their options', () => {
    expect(askKey(QUESTION)).not.toBe(askKey({ ...QUESTION, options: ['dev', 'prod'] }));
  });
});

describe('answering', () => {
  it('closes the entry and hands back the answer', () => {
    const entry = inbox.raise(QUESTION);
    inbox.answer(entry.key, 'staging');

    expect(inbox.open()).toHaveLength(0);
    expect(inbox.entry(entry.key)?.answer).toBe('staging');
  });

  it('B.3.7: a repeat ask from the same run does not duplicate itself in runs', () => {
    inbox.raise(QUESTION);
    const second = inbox.raise(QUESTION);
    expect(second.runs).toEqual(['alpha']);
    expect(second.asked).toBe(2);
  });

  it('B.3.7: a different run asking identically gets its own entry, not a shared one', () => {
    const first = inbox.raise(QUESTION);
    const second = inbox.raise({ ...QUESTION, run: 'beta' });
    expect(second.key).not.toBe(first.key);
    expect(second.runs).toEqual(['beta']);
  });

  it('reopens if the same question is asked after an answer', () => {
    const entry = inbox.raise(QUESTION);
    inbox.answer(entry.key, 'staging');
    const again = inbox.raise({ ...QUESTION });

    expect(again.answer).toBeUndefined();
    expect(inbox.open()).toHaveLength(1);
  });

  it('ignores an answer to a key nobody asked', () => {
    expect(() => inbox.answer('not-a-key', 'yes')).not.toThrow();
    expect(inbox.open()).toHaveLength(0);
  });

  it('reads an answer a person dropped in by hand', () => {
    const entry = inbox.raise(QUESTION);
    writeFileSync(
      join(dir, '.forge', 'inbox', `${entry.key}.json`),
      JSON.stringify({ ...entry, answer: 'dev' }),
      'utf8',
    );
    expect(inbox.entry(entry.key)?.answer).toBe('dev');
    expect(inbox.open()).toHaveLength(0);
  });
});

describe('what a blocked worker does', () => {
  it('is told to park rather than to wait', () => {
    const entry = inbox.raise(QUESTION);
    expect(entry.disposition).toBe('park');
  });

  it('carries the prompt a resumed session gets once answered', () => {
    const entry = inbox.raise(QUESTION);
    inbox.answer(entry.key, 'staging');
    const resume = inbox.resumePrompt(entry.key);
    expect(resume).toMatch(/staging/);
    expect(resume).toMatch(/Which environment/);
  });
});

describe('code-review finding: deliverAnswer targets the goal id, not the segment name', () => {
  it('queues the resume message under the goal, which a handoff never renames', async () => {
    const { deliverAnswer } = await import('../../src/forge/runinbox.js');
    const { RunInbox } = await import('../../src/forge/runinbox.js');
    process.env['FORGE_HOME'] = dir;

    const entry = inbox.raise({ ...QUESTION, run: 'goal-3', goal: 'goal' });
    await deliverAnswer(entry, entry.key, 'staging');

    // The falsifier this closes: queuing under 'goal-3' (the segment answered.runs would
    // give you without this fix) would leave the live session -- which only polls its
    // stable goal id's inbox -- with nothing to read.
    expect(new RunInbox('goal').unread()).toHaveLength(1);
    expect(new RunInbox('goal-3').unread()).toHaveLength(0);
  });

  it('falls back to the run name when no ask ever recorded a goal', async () => {
    const { deliverAnswer, RunInbox } = await import('../../src/forge/runinbox.js');
    process.env['FORGE_HOME'] = dir;

    const entry = inbox.raise({ ...QUESTION, run: 'no-goal-run' });
    await deliverAnswer(entry, entry.key, 'staging');

    expect(new RunInbox('no-goal-run').unread()).toHaveLength(1);
  });
});
