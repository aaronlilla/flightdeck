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

  it('treats the same question from another run as the same wall', () => {
    // Two runs blocked on one decision is one decision to make, not two.
    expect(askKey({ ...QUESTION, run: 'alpha' }))
      .toBe(askKey({ ...QUESTION, run: 'beta' }));
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

  it('lists every run that was waiting on it', () => {
    inbox.raise(QUESTION);
    const second = inbox.raise({ ...QUESTION, run: 'beta' });
    expect(second.runs.sort()).toEqual(['alpha', 'beta']);
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
