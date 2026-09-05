/**
 * X4: the rail-thread router. Every specimen here hands `classify`/`act`/`route` a
 * fake `Reasoner` -- nothing in this file, or in the code it exercises, reaches a
 * real model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Reasoner } from '../../src/forge/contracts.js';
import { Inbox } from '../../src/forge/inbox.js';
import { act, classify, route, type RouterOutcome } from '../../src/forge/router.js';

function fakeReasoner(reply: string): Reasoner {
  return { provider: 'claude', call: async () => ({ text: reply }) };
}

const noopJournal = { append: (event: Record<string, unknown>) => ({ id: 'x', seq: 0, at: 0, version: 1, ...event } as never) };

describe('classify', () => {
  it('reads a plain classification word back from the reasoner', async () => {
    expect(await classify(fakeReasoner('answer'), 'dev works')).toBe('answer');
    expect(await classify(fakeReasoner('This looks like new WORK to me.'), 'add the fee')).toBe('intake');
    expect(await classify(fakeReasoner('question'), 'what is running')).toBe('question');
    expect(await classify(fakeReasoner('system'), 'stop retrying so fast')).toBe('system');
  });

  it('falls back to intake rather than dropping a message it could not parse', async () => {
    expect(await classify(fakeReasoner('uh, not sure'), 'hello')).toBe('intake');
  });
});

describe('act', () => {
  it('X4: an answer resumes the open ask it matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-router-'));
    const inbox = new Inbox(dir);
    const entry = inbox.raise({ run: 'withdrawal-fee', question: 'dev or production?', options: ['dev', 'production'] });
    const outcome = await act(fakeReasoner(`${entry.key}\ndev`), 'answer', 'use dev', {
      inbox, journal: noopJournal, stateSummary: () => '', openAsks: () => inbox.open(),
    });
    expect(outcome).toMatchObject({ class: 'answer', key: entry.key, answer: 'dev', delivered: true });
    expect(inbox.open()).toHaveLength(0);
  });

  it('X4: an answer naming a key that is not open reaches intake instead of nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-router-'));
    const inbox = new Inbox(dir);
    const outcome = await act(fakeReasoner('not-a-real-key\ndev'), 'answer', 'use dev', {
      inbox, journal: noopJournal, stateSummary: () => '', openAsks: () => inbox.open(),
    });
    expect(outcome.class).toBe('intake');
  });

  it('X4: new work becomes an intake.requested journal row', async () => {
    const journaled: Record<string, unknown>[] = [];
    const outcome = await act(fakeReasoner('unused'), 'intake', 'add a new fee flow', {
      inbox: new Inbox(mkdtempSync(join(tmpdir(), 'forge-router-'))),
      journal: { append: (event) => { journaled.push(event); return event as never; } },
      stateSummary: () => '',
      openAsks: () => [],
    });
    expect(outcome).toEqual({ class: 'intake', text: 'add a new fee flow' });
    expect(journaled).toEqual([{ event: 'intake.requested', actor: 'router', note: 'add a new fee flow' }]);
  });

  it('X4: a question gets a read-only answer built from state, never a side effect', async () => {
    const inbox = new Inbox(mkdtempSync(join(tmpdir(), 'forge-router-')));
    const outcome = await act(fakeReasoner('two lanes are running.'), 'question', 'what is running', {
      inbox, journal: noopJournal, stateSummary: () => 'two lanes running', openAsks: () => [],
    }) as Extract<RouterOutcome, { class: 'question' }>;
    expect(outcome.class).toBe('question');
    expect(outcome.answer).toBe('two lanes are running.');
    expect(inbox.open()).toHaveLength(0);
  });

  it('X4: a system instruction the act step reads as a bug becomes a gotcha row', async () => {
    const journaled: Record<string, unknown>[] = [];
    await act(fakeReasoner('gotcha'), 'system', 'that retried way too fast', {
      inbox: new Inbox(mkdtempSync(join(tmpdir(), 'forge-router-'))),
      journal: { append: (event) => { journaled.push(event); return event as never; } },
      stateSummary: () => '',
      openAsks: () => [],
    });
    expect(journaled[0]).toMatchObject({ event: 'gotcha' });
  });

  it('X4: a system instruction the act step reads as a suggestion becomes a proposal row', async () => {
    const journaled: Record<string, unknown>[] = [];
    await act(fakeReasoner('proposal'), 'system', 'maybe raise the budget', {
      inbox: new Inbox(mkdtempSync(join(tmpdir(), 'forge-router-'))),
      journal: { append: (event) => { journaled.push(event); return event as never; } },
      stateSummary: () => '',
      openAsks: () => [],
    });
    expect(journaled[0]).toMatchObject({ event: 'proposal' });
  });
});

describe('route', () => {
  // `intake` needs only the classify call; `question` exercises both steps, since its
  // act call is what actually answers.
  it('classifies then acts in one call, both steps hitting the fake reasoner', async () => {
    let call = 0;
    const reasoner: Reasoner = {
      provider: 'claude',
      call: async () => {
        call += 1;
        return { text: call === 1 ? 'question' : 'two lanes are running' };
      },
    };
    const outcome = await route(reasoner, 'what is running', {
      inbox: new Inbox(mkdtempSync(join(tmpdir(), 'forge-router-'))),
      journal: noopJournal,
      stateSummary: () => 'two lanes running',
      openAsks: () => [],
    });
    expect(outcome).toEqual({ class: 'question', answer: 'two lanes are running' });
    expect(call).toBe(2);
  });

  it('a classification needing no act call (intake) still routes end to end', async () => {
    const journaled: Record<string, unknown>[] = [];
    const outcome = await route(fakeReasoner('intake'), 'build the new thing', {
      inbox: new Inbox(mkdtempSync(join(tmpdir(), 'forge-router-'))),
      journal: { append: (event) => { journaled.push(event); return event as never; } },
      stateSummary: () => '',
      openAsks: () => [],
    });
    expect(outcome.class).toBe('intake');
    expect(journaled).toHaveLength(1);
  });
});
