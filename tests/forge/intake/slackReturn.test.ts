/**
 * The reply coming back (`intake/slackReturn.ts`) against an injected `fetch`.
 *
 * The fixture thread carries replies from TWO users, which is the falsifier the brief
 * names: a one-reply thread would pass whether or not the reader checks who typed it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Watermark } from '../../../src/forge/contracts.js';
import { Inbox } from '../../../src/forge/inbox.js';
import type { SlackConfig } from '../../../src/forge/intake/slack.js';
import { openPasses, optionMatching, readSlackReplies } from '../../../src/forge/intake/slackReturn.js';

const THREAD_TS = '1757600000.000100';

function tempInbox(): Inbox {
  return new Inbox(mkdtempSync(join(tmpdir(), 'inbox-return-')));
}

function emptyMark(): Watermark {
  return { source: 'slack', committedAt: 0, idsAtCommittedAt: [] };
}

interface FetchLog { urls: string[] }

function configWith(payload: unknown, log: FetchLog): SlackConfig {
  return {
    token: 'test-token',
    channel: 'C1',
    users: { joe: 'U0JOE', jason: 'U0JASON' },
    fetchFn: (async (url: string) => {
      log.urls.push(url);
      return { json: async () => payload } as Response;
    }) as unknown as typeof fetch,
  };
}

/** The question, then somebody else, then the person it was actually passed to. */
const TWO_USER_THREAD = {
  ok: true,
  messages: [
    { user: 'U0BOT', text: '<@U0JOE> quick one on BBZ-277: hide or zero?', ts: THREAD_TS },
    { user: 'U0JASON', text: 'I would show a zero personally', ts: '1757600100.000200' },
    { user: 'U0JOE', text: 'hide it, the endpoint returns null there', ts: '1757600200.000300' },
  ],
};

function passedAsk(inbox: Inbox): string {
  const entry = inbox.raise({
    run: 'item:Q-1', question: 'Do we hide the row or show a zero?',
    options: ['hide', 'zero'], kind: 'question', ticket: 'BBZ-277',
  });
  inbox.pass(entry.key, 'Joe', 1_757_600_000_000, THREAD_TS);
  return entry.key;
}

describe('readSlackReplies', () => {
  it('takes only the passed user reply as the answer, with two users in the thread', async () => {
    const inbox = tempInbox();
    const key = passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const rows: Record<string, unknown>[] = [];

    const result = await readSlackReplies(emptyMark(), {
      config: configWith(TWO_USER_THREAD, log), inbox, append: (row) => rows.push(row),
    });

    expect(result.ok).toBe(true);
    expect(result.attached).toEqual([
      { askKey: key, from: 'Joe', text: 'hide it, the endpoint returns null there', thread: THREAD_TS },
    ]);

    const entry = inbox.entry(key)!;
    expect(entry.answeredBy).toBe('Joe');
    expect(entry.reply).toBe('hide it, the endpoint returns null there');
    // The ask is still open: a sentence is not an option, and the operator still confirms.
    expect(entry.answer).toBeUndefined();

    const returned = rows.filter((row) => row['event'] === 'ask.returned');
    expect(returned).toHaveLength(1);
    expect(returned[0]!['from']).toBe('Joe');
  });

  it('reads each open pass once per tick, and advances the watermark so a reply is read once', async () => {
    const inbox = tempInbox();
    const key = passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const deps = { config: configWith(TWO_USER_THREAD, log), inbox, append: () => {} };

    const reads = (): string[] => log.urls.filter((url) => url.includes('conversations.replies'));

    const first = await readSlackReplies(emptyMark(), deps);
    // The rate-limit rule is one `conversations.replies` per open pass per tick. The
    // acknowledgement posts through the same injected fetch, so count reads, not calls.
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toContain(encodeURIComponent(THREAD_TS));
    expect(first.watermark.committedAt).toBeGreaterThan(0);

    // The ask now has an answeredBy, so it is no longer an open pass and is not re-read.
    expect(openPasses(inbox)).toHaveLength(0);
    const second = await readSlackReplies(first.watermark, deps);
    expect(reads()).toHaveLength(1);
    expect(second.attached).toHaveLength(0);
    expect(inbox.entry(key)!.reply).toBe('hide it, the endpoint returns null there');
  });

  it('leaves the ask untouched when nobody has replied', async () => {
    const inbox = tempInbox();
    const key = passedAsk(inbox);
    const log: FetchLog = { urls: [] };

    const result = await readSlackReplies(emptyMark(), {
      config: configWith({ ok: true, messages: [TWO_USER_THREAD.messages[0]] }, log), inbox, append: () => {},
    });

    expect(result.attached).toHaveLength(0);
    expect(inbox.entry(key)!.answeredBy).toBeNull();
  });

  it('a reply from nobody the question was passed to leaves the ask unanswered', async () => {
    const inbox = tempInbox();
    const key = passedAsk(inbox);
    const log: FetchLog = { urls: [] };

    const result = await readSlackReplies(emptyMark(), {
      config: configWith({
        ok: true,
        messages: [TWO_USER_THREAD.messages[0], TWO_USER_THREAD.messages[1]],
      }, log),
      inbox,
      append: () => {},
    });

    expect(result.attached).toHaveLength(0);
    expect(inbox.entry(key)!.answeredBy).toBeNull();
    expect(inbox.entry(key)!.reply).toBeUndefined();
  });

  it('an ok:false response leaves the watermark where it was and journals slack.failed', async () => {
    const inbox = tempInbox();
    const key = passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const rows: Record<string, unknown>[] = [];
    const mark = emptyMark();

    const result = await readSlackReplies(mark, {
      config: configWith({ ok: false, error: 'ratelimited' }, log), inbox, append: (row) => rows.push(row),
    });

    expect(result.ok).toBe(false);
    expect(result.watermark).toEqual(mark);
    expect(result.attached).toHaveLength(0);
    expect(rows.map((row) => row['event'])).toEqual(['slack.failed']);
    expect(rows[0]!['reason']).toBe('ratelimited');
    expect(inbox.entry(key)!.answeredBy).toBeNull();
  });

  // Aaron, 2026-09-11: "the person who replied needs to get feedback that the system got
  // their reply." A teammate who answers into a thread and hears nothing cannot tell
  // whether it landed, whether it was understood, or whether to say more.
  it('posts exactly one acknowledgement into the same thread when it attaches an answer', async () => {
    const inbox = tempInbox();
    const key = passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const acks: { thread: string; text: string }[] = [];

    await readSlackReplies(emptyMark(), {
      config: configWith(TWO_USER_THREAD, log), inbox, append: () => {},
      acknowledge: async (thread, text) => { acks.push({ thread, text }); return { ok: true }; },
    });

    expect(acks).toHaveLength(1);
    expect(acks[0]!.thread).toBe(THREAD_TS);
    expect(acks[0]!.text.toLowerCase()).toContain('got');
    // Plain words, never a bare identifier on its own.
    expect(acks[0]!.text).not.toMatch(/^BBZ-277/);
    expect(inbox.entry(key)!.answeredBy).toBe('Joe');
  });

  it('never acknowledges the same reply twice', async () => {
    const inbox = tempInbox();
    passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const acks: string[] = [];
    const deps = {
      config: configWith(TWO_USER_THREAD, log), inbox, append: () => {},
      acknowledge: async (_thread: string, text: string) => { acks.push(text); return { ok: true }; },
    };

    const first = await readSlackReplies(emptyMark(), deps);
    await readSlackReplies(first.watermark, deps);
    await readSlackReplies(first.watermark, deps);

    expect(acks).toHaveLength(1);
  });

  it('says plainly when it cannot read the reply as one of the options', async () => {
    const inbox = tempInbox();
    passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const acks: string[] = [];

    await readSlackReplies(emptyMark(), {
      config: configWith({
        ok: true,
        messages: [
          TWO_USER_THREAD.messages[0],
          { user: 'U0JOE', text: 'depends what the endpoint does on a cold wallet', ts: '1757600200.000300' },
        ],
      }, log),
      inbox,
      append: () => {},
      acknowledge: async (_thread, text) => { acks.push(text); return { ok: true }; },
    });

    expect(acks).toHaveLength(1);
    expect(acks[0]!.toLowerCase()).toContain("can't tell which");
  });

  it('acknowledges a reply it can read as one of the options differently', async () => {
    const inbox = tempInbox();
    passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const acks: string[] = [];

    await readSlackReplies(emptyMark(), {
      config: configWith({
        ok: true,
        messages: [TWO_USER_THREAD.messages[0], { user: 'U0JOE', text: '1', ts: '1757600200.000300' }],
      }, log),
      inbox,
      append: () => {},
      acknowledge: async (_thread, text) => { acks.push(text); return { ok: true }; },
    });

    expect(acks).toHaveLength(1);
    expect(acks[0]!.toLowerCase()).not.toContain("can't tell which");
    expect(acks[0]).toContain('hide the row');
  });

  it('says nothing to somebody the question was not passed to', async () => {
    const inbox = tempInbox();
    passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const acks: string[] = [];

    await readSlackReplies(emptyMark(), {
      config: configWith({
        ok: true, messages: [TWO_USER_THREAD.messages[0], TWO_USER_THREAD.messages[1]],
      }, log),
      inbox,
      append: () => {},
      acknowledge: async (_thread, text) => { acks.push(text); return { ok: true }; },
    });

    expect(acks).toHaveLength(0);
  });

  it('a failed acknowledgement never un-attaches the answer it was acknowledging', async () => {
    const inbox = tempInbox();
    const key = passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const rows: Record<string, unknown>[] = [];

    const result = await readSlackReplies(emptyMark(), {
      config: configWith(TWO_USER_THREAD, log), inbox, append: (row) => rows.push(row),
      acknowledge: async () => ({ ok: false, reason: 'not_in_channel' }),
    });

    expect(result.attached).toHaveLength(1);
    const entry = inbox.entry(key)!;
    expect(entry.answeredBy).toBe('Joe');
    expect(entry.reply).toBe('hide it, the endpoint returns null there');
    expect(rows.map((row) => row['event'])).toContain('ask.returned');
  });

  // Found by an adversarial review of the acknowledgement, 2026-09-11, after it had
  // already merged. `optionMatching` read the reply with a bare substring test, so a
  // negated answer matched the thing it was negating: "not hide" against an option
  // "hide". The acknowledgement then told the teammate the opposite of what they wrote.
  // The recorded answer was never affected -- but a message whose whole job is to
  // reassure somebody their answer landed must not lie back at them.
  it('never reads a negated reply as agreement with the option it negates', () => {
    expect(optionMatching(['hide', 'zero'], 'not hide')).toBeUndefined();
    expect(optionMatching(['hide', 'zero'], 'definitely not hide')).toBeUndefined();
    expect(optionMatching(['no', 'yes'], 'not sure')).toBeUndefined();
    expect(optionMatching(['hide the row', 'show a zero'], "don't hide the row")).toBeUndefined();
  });

  it('still reads the answers a person plainly gives', () => {
    expect(optionMatching(['hide', 'zero'], 'hide')).toBe('hide');
    expect(optionMatching(['hide', 'zero'], '  ZERO ')).toBe('zero');
    expect(optionMatching(['hide the row', 'show a zero'], '2')).toBe('show a zero');
    expect(optionMatching(['hide', 'zero'], '1')).toBe('hide');
  });

  it('says it cannot tell rather than guessing at anything else', () => {
    expect(optionMatching(['hide', 'zero'], 'depends on the endpoint')).toBeUndefined();
    expect(optionMatching(['hide', 'zero'], '0')).toBeUndefined();
    expect(optionMatching(['hide', 'zero'], '-1')).toBeUndefined();
    expect(optionMatching(['hide', 'zero'], '1.5')).toBeUndefined();
    expect(optionMatching(['', 'zero'], '')).toBeUndefined();
  });

  it('a negated reply gets the "I cannot tell" sentence, not a claim about the option', async () => {
    const inbox = tempInbox();
    passedAsk(inbox);
    const log: FetchLog = { urls: [] };
    const acks: string[] = [];

    await readSlackReplies(emptyMark(), {
      config: configWith({
        ok: true,
        messages: [TWO_USER_THREAD.messages[0], { user: 'U0JOE', text: 'not hide', ts: '1757600200.000300' }],
      }, log),
      inbox,
      append: () => {},
      acknowledge: async (_thread, text) => { acks.push(text); return { ok: true }; },
    });

    expect(acks).toHaveLength(1);
    expect(acks[0]!.toLowerCase()).toContain("can't tell which");
    expect(acks[0]).not.toContain('"hide"');
  });

  it('reads nothing at all when Slack is not configured', async () => {
    const inbox = tempInbox();
    passedAsk(inbox);
    const result = await readSlackReplies(emptyMark(), { config: undefined, inbox, append: () => {} });
    expect(result.ok).toBe(true);
    expect(result.attached).toHaveLength(0);
  });
});
