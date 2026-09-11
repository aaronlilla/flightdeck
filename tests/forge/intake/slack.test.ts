/**
 * The Slack question client (`intake/slack.ts`) against an injected `fetch` -- nothing in
 * this file reaches the network, and nothing in it carries a real token.
 *
 * The token in these fixtures is the literal string `test-token`. A grep for the prefix a
 * real Slack bot token starts with must return nothing anywhere in this repository, so
 * that prefix is not written here either -- a fixture that spells it out defeats the very
 * check it is meant to survive.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Inbox } from '../../../src/forge/inbox.js';
import {
  MAX_OPEN_PASSES, buildPassMessage, missingEnvSentence, missingSlackEnv, openPassCount,
  parseSlackUsers, postQuestion, postThreadReply, slackConfigFromEnv, type SlackConfig,
} from '../../../src/forge/intake/slack.js';

function tempInbox(): Inbox {
  return new Inbox(mkdtempSync(join(tmpdir(), 'inbox-slack-')));
}

interface FetchLog {
  calls: { url: string; init: RequestInit }[];
}

function fakeFetch(payload: unknown, log: FetchLog): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    log.calls.push({ url, init });
    return { json: async () => payload } as Response;
  }) as unknown as typeof fetch;
}

function config(log: FetchLog, payload: unknown = { ok: true, channel: 'C1', ts: '1757600000.000100' }): SlackConfig {
  return {
    token: 'test-token',
    channel: 'C1',
    users: { joe: 'U0JOE', jason: 'U0JASON' },
    fetchFn: fakeFetch(payload, log),
  };
}

function raiseAsk(inbox: Inbox): string {
  const entry = inbox.raise({
    run: 'item:Q-1', question: 'Do we hide the row or show a zero?',
    options: ['hide', 'zero'], recommended: 0, kind: 'question', ticket: 'BBZ-277',
  });
  return entry.key;
}

const passes = () => ({ verdict: 'SILENT' });

describe('slackConfigFromEnv', () => {
  it('is undefined until all three variables are set, and names the missing ones', () => {
    expect(slackConfigFromEnv({})).toBeUndefined();
    expect(missingSlackEnv({ FORGE_SLACK_BOT_TOKEN: 'test-token' }))
      .toEqual(['FORGE_SLACK_QUESTIONS_CHANNEL', 'FORGE_SLACK_USERS']);
    expect(missingEnvSentence(['FORGE_SLACK_BOT_TOKEN'])).toContain('FORGE_SLACK_BOT_TOKEN');
  });

  it('reads the user list as name=id pairs, case-insensitively by name', () => {
    expect(parseSlackUsers('Joe=U0JOE, Jason=U0JASON Haiping=U0HAI')).toEqual({
      joe: 'U0JOE', jason: 'U0JASON', haiping: 'U0HAI',
    });
  });
});

describe('postQuestion', () => {
  it('posts the exact body, with the mention, and records the pass on the ask', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };
    const rows: Record<string, unknown>[] = [];

    const outcome = await postQuestion(key, 'Joe', {
      config: config(log), inbox, readability: passes,
      append: (row) => rows.push(row), now: () => 1_757_600_000_000,
    });

    expect(outcome.ok).toBe(true);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    const sent = JSON.parse(String(log.calls[0]!.init.body));
    expect(sent.channel).toBe('C1');
    expect(sent.text).toBe([
      '<@U0JOE> quick one on BBZ-277: Do we hide the row or show a zero?',
      '1. hide  2. zero',
      'Reply in this thread and it comes back to me.',
    ].join('\n'));
    expect(sent.thread_ts).toBeUndefined();

    const entry = inbox.entry(key)!;
    expect(entry.passedTo).toBe('Joe');
    expect(entry.passedAt).toBe(1_757_600_000_000);
    expect(entry.passedThread).toBe('1757600000.000100');
    expect(entry.answeredBy).toBeNull();
  });

  it('journals the write intent before the call, and ask.passed only after it lands', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };
    const rows: Record<string, unknown>[] = [];
    let callsAtIntent = -1;

    await postQuestion(key, 'Joe', {
      config: config(log), inbox, readability: passes,
      append: (row) => {
        if (row['event'] === 'external.intent') callsAtIntent = log.calls.length;
        rows.push(row);
      },
    });

    expect(callsAtIntent).toBe(0);
    const names = rows.map((row) => row['event']);
    expect(names[0]).toBe('external.intent');
    // One intent per post, not two: `call` has no event name of its own and must not be
    // journaled as a second intent (live journal, 2026-09-11).
    expect(names.filter((event) => event === 'external.intent')).toHaveLength(1);
    expect(names).toContain('external.complete');
    expect(names).toContain('ask.passed');
    expect(names.indexOf('external.intent')).toBeLessThan(names.indexOf('ask.passed'));
  });

  it('never puts the token in a journal row', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };
    const rows: Record<string, unknown>[] = [];
    await postQuestion(key, 'Joe', { config: config(log), inbox, readability: passes, append: (row) => rows.push(row) });
    expect(JSON.stringify(rows)).not.toContain('test-token');
  });

  it('refuses without calling fetch when the environment is not configured', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };

    const outcome = await postQuestion(key, 'Joe', {
      config: undefined, env: {}, inbox, readability: passes, append: () => {},
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('FORGE_SLACK_BOT_TOKEN');
    expect(log.calls).toHaveLength(0);
    expect(inbox.entry(key)!.passedTo).toBeUndefined();
  });

  it('refuses without calling fetch when the name is unknown, and says who it knows', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };

    const outcome = await postQuestion(key, 'Mallory', {
      config: config(log), inbox, readability: passes, append: () => {},
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('Mallory');
    expect(outcome.reason).toContain('joe');
    expect(log.calls).toHaveLength(0);
  });

  it('refuses without calling fetch when the voice guard denies', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };

    const outcome = await postQuestion(key, 'Joe', {
      config: config(log), inbox, readability: passes, append: () => {},
      voice: () => ({ ok: false, reason: 'agent/session self-narration: "this session"' }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('self-narration');
    expect(log.calls).toHaveLength(0);
  });

  it('refuses without calling fetch when readability denies', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };

    const outcome = await postQuestion(key, 'Joe', {
      config: config(log), inbox, append: () => {},
      readability: () => ({ verdict: 'DENY', reason: 'banned word(s) in prose: basically' }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('banned word');
    expect(log.calls).toHaveLength(0);
  });

  it('an ok:false response clears the three fields and journals slack.failed and action.failed', async () => {
    const inbox = tempInbox();
    const key = raiseAsk(inbox);
    const log: FetchLog = { calls: [] };
    const rows: Record<string, unknown>[] = [];
    // The console set the fields the moment the operator clicked; the failure rolls them back.
    inbox.pass(key, 'Joe', 1_757_600_000_000, null);

    const outcome = await postQuestion(key, 'Joe', {
      config: config(log, { ok: false, error: 'not_in_channel' }), inbox, readability: passes,
      append: (row) => rows.push(row),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('not_in_channel');

    const entry = inbox.entry(key)!;
    expect(entry.passedTo).toBeNull();
    expect(entry.passedAt).toBeNull();
    expect(entry.passedThread).toBeNull();

    const names = rows.map((row) => row['event']);
    expect(names).toContain('slack.failed');
    expect(names).toContain('action.failed');
    expect(names).not.toContain('ask.passed');
    expect(rows.find((row) => row['event'] === 'slack.failed')!['reason']).toBe('not_in_channel');
  });

  it(`refuses an eleventh open pass without calling fetch`, async () => {
    const inbox = tempInbox();
    const log: FetchLog = { calls: [] };
    for (let i = 0; i < MAX_OPEN_PASSES; i += 1) {
      const entry = inbox.raise({ run: `item:Q-${i}`, question: `question ${i}`, kind: 'question' });
      inbox.pass(entry.key, 'Joe', 1, `17576.${i}`);
    }
    expect(openPassCount(inbox)).toBe(MAX_OPEN_PASSES);
    const key = raiseAsk(inbox);

    const outcome = await postQuestion(key, 'Joe', {
      config: config(log), inbox, readability: passes, append: () => {},
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain(String(MAX_OPEN_PASSES));
    expect(log.calls).toHaveLength(0);
  });
});

describe('postThreadReply', () => {
  // A reaction would be the cheaper acknowledgement and cannot be used: the bot holds
  // chat:write, groups:history and groups:read, so reactions.add fails with missing_scope.
  // This asserts the endpoint, so a later "simplification" to a reaction breaks here
  // rather than at run time in front of a teammate.
  it('posts a threaded message, never a reaction', async () => {
    const log: FetchLog = { calls: [] };
    const outcome = await postThreadReply('1757600000.000100', 'Got it, thanks.', {
      config: config(log), readability: passes, append: () => {},
    });

    expect(outcome.ok).toBe(true);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(log.calls[0]!.url).not.toContain('reactions');
    const sent = JSON.parse(String(log.calls[0]!.init.body));
    expect(sent.thread_ts).toBe('1757600000.000100');
    expect(sent.channel).toBe('C1');
    expect(sent.text).toBe('Got it, thanks.');
  });

  it('refuses without calling fetch when a guard denies the sentence', async () => {
    const log: FetchLog = { calls: [] };
    const voiceDenied = await postThreadReply('1757600000.000100', 'Aaron said to hide it', {
      config: config(log), readability: passes, append: () => {},
      voice: () => ({ ok: false, reason: 'Aaron named in the third person' }),
    });
    expect(voiceDenied.ok).toBe(false);
    expect(log.calls).toHaveLength(0);

    const readabilityDenied = await postThreadReply('1757600000.000100', 'Got it.', {
      config: config(log), append: () => {},
      readability: () => ({ verdict: 'DENY', reason: 'banned word(s) in prose: just' }),
    });
    expect(readabilityDenied.ok).toBe(false);
    expect(log.calls).toHaveLength(0);
  });

  it('reports an ok:false response rather than claiming it landed', async () => {
    const log: FetchLog = { calls: [] };
    const outcome = await postThreadReply('1757600000.000100', 'Got it, thanks.', {
      config: config(log, { ok: false, error: 'not_in_channel' }), readability: passes, append: () => {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('not_in_channel');
  });
});

describe('buildPassMessage', () => {
  it('mentions the teammate by id and never names Aaron in the third person', () => {
    const inbox = tempInbox();
    const entry = inbox.entry(raiseAsk(inbox))!;
    const text = buildPassMessage(entry, 'Joe', 'U0JOE');
    expect(text.startsWith('<@U0JOE>')).toBe(true);
    expect(text).not.toMatch(/Aaron/);
    expect(text).toContain('Reply in this thread');
  });
});
