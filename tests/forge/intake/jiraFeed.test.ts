/**
 * R-101: the Jira feed. Every specimen drives `runFeedActivity` with a fixture board, a
 * fake reasoner, a recording post and a real `Inbox` in a temp dir -- no network, no
 * model call.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { QueueItem } from '../../../src/shared/console-model.js';
import { Inbox } from '../../../src/forge/inbox.js';
import {
  FEED_RUN, LEAVE_OPTION, adfMentions, classifyComment, feedJql, feedText, fetchFeedIssues, fileFeedLedger,
  memoryFeedLedger, parseDecision, replyRefusal, runFeedActivity,
  type FeedActivityDeps, type FeedComment, type FeedIssue,
} from '../../../src/forge/intake/jiraFeed.js';

const ME = { accountId: 'acc-me', names: ['Robin'] };
const START = Date.parse('2026-09-14T10:00:00Z');
const LATER = START + 60_000;

function comment(extra: Partial<FeedComment> = {}): FeedComment {
  return { id: 'c1', authorAccountId: 'acc-pat', authorName: 'Pat Doe', body: 'hey can you check this', created: LATER, mentions: [], ...extra };
}

function issue(extra: Partial<FeedIssue> = {}): FeedIssue {
  return {
    key: 'ABC-1', summary: 'Login button is grey', description: 'The button is grey on the login page.', descriptionMentions: [],
    status: 'Backlog', assigneeAccountId: 'acc-other', assigneeName: 'Other', reporterAccountId: 'acc-pat', reporterName: 'Pat Doe',
    created: START - 86_400_000, updated: LATER, comments: [], ...extra,
  };
}

function decision(action: string, reply = '', directed = 'yes'): string {
  return `ACTION: ${action}\nDIRECTED: ${directed}\nWHY: because\nREPLY: ${reply}`;
}

/** The critic's four lines. The gauntlet runs a second call per round against the same
 *  reasoner, so every harness has to answer one; `critique()` with no argument is the
 *  pass that lets a decision-only specimen behave as it did before the loop existed. */
function critique(over: { verdict?: string; supported?: string; gap?: string } = {}): string {
  return [
    `VERDICT: ${over.verdict ?? 'ours'}`,
    `SUPPORTED: ${over.supported ?? 'yes'}`,
    `GAP: ${over.gap ?? 'none'}`,
    'WHY: it answers the question',
  ].join('\n');
}

/** A comment by somebody else, long enough to serve as the bar. The loop only compares
 *  against real comments, so a board with none auto-passes the critic by design. */
function barComment(extra: Partial<FeedComment> = {}): FeedComment {
  return comment({
    id: 'bar1', authorAccountId: 'acc-pat', authorName: 'Pat Doe',
    // Older than the poll window and aimed at nobody, so it is bar material and never a
    // candidate in its own right.
    created: START - 86_400_000,
    body: 'retested on the latest build and the grey button is gone now, closing this one out',
    ...extra,
  });
}

function isCriticPrompt(prompt: string): boolean {
  return prompt.includes('You are a harsh critic');
}

interface Harness {
  deps: FeedActivityDeps;
  posts: { ticket: string; body: string }[];
  sends: { runKey: string; text: string }[];
  rows: Record<string, unknown>[];
  inbox: Inbox;
  reasoner: ReturnType<typeof vi.fn>;
  board: FeedIssue[];
  jql: string[];
}

function harness(opts: { board?: FeedIssue[]; reply?: string | Error; items?: Partial<QueueItem>[]; postOk?: boolean; now?: number } = {}): Harness {
  const posts: Harness['posts'] = [];
  const sends: Harness['sends'] = [];
  const rows: Record<string, unknown>[] = [];
  const jql: string[] = [];
  const inbox = new Inbox(mkdtempSync(join(tmpdir(), 'feed-inbox-')));
  const board = opts.board ?? [];
  const reasoner = vi.fn(async ({ prompt }: { prompt: string }) => {
    if (isCriticPrompt(prompt)) return { text: critique() };
    if (opts.reply instanceof Error) throw opts.reply;
    return { text: opts.reply ?? decision('ignore') };
  });
  const deps: FeedActivityDeps = {
    project: 'ABC',
    me: async () => ME,
    operatorName: () => 'Robin Roe',
    fetchIssues: async (query) => { jql.push(query); return board; },
    ledger: memoryFeedLedger(START),
    reasoner: { call: reasoner },
    post: async (ticket, body) => {
      posts.push({ ticket, body });
      return opts.postOk === false ? { ok: false, body: 'readability refused this comment: too long' } : { ok: true, status: 201 };
    },
    raise: (ask) => inbox.raise(ask),
    inboxEntries: () => inbox.all(),
    queueItems: () => (opts.items ?? []) as QueueItem[],
    sendTo: (runKey, text) => { sends.push({ runKey, text }); },
    journal: { append: (row) => { rows.push(row); } },
    now: () => opts.now ?? LATER + 5_000,
  };
  return { deps, posts, sends, rows, inbox, reasoner, board, jql };
}

describe('reading Atlassian Document Format', () => {
  const body = {
    type: 'doc', version: 1, content: [{
      type: 'paragraph', content: [
        { type: 'mention', attrs: { id: 'acc-me', text: '@Robin Roe' } },
        { type: 'text', text: ' can you look?' },
      ],
    }],
  };

  it('finds mention account ids', () => {
    expect(adfMentions(body)).toEqual(['acc-me']);
  });

  it('keeps a mention visible in the flattened text', () => {
    expect(feedText(body)).toBe('@Robin Roe can you look?');
  });
});

describe('classifyComment', () => {
  it('ranks self, mention, my ticket, name, then maybe', () => {
    expect(classifyComment(issue(), comment({ authorAccountId: 'acc-me', mentions: ['acc-me'] }), ME)).toBe('self');
    expect(classifyComment(issue(), comment({ mentions: ['acc-me'] }), ME)).toBe('mention');
    expect(classifyComment(issue({ assigneeAccountId: 'acc-me' }), comment(), ME)).toBe('my-ticket');
    expect(classifyComment(issue({ reporterAccountId: 'acc-me' }), comment(), ME)).toBe('my-ticket');
    expect(classifyComment(issue(), comment({ body: 'robin, is this yours?' }), ME)).toBe('named');
    expect(classifyComment(issue(), comment({ body: 'robinson crusoe' }), ME)).toBe('maybe');
  });
});

describe('parseDecision', () => {
  it('reads the line form, with a multi-line reply', () => {
    expect(parseDecision(decision('reply', 'yep\nshipped it'))).toEqual({ action: 'reply', directed: true, why: 'because', reply: 'yep\nshipped it' });
  });

  it('reads the JSON form', () => {
    expect(parseDecision('{"action":"defer","directed":"yes","why":"w","reply":"r"}')).toEqual({ action: 'defer', directed: true, why: 'w', reply: 'r' });
  });

  it('returns null for anything else', () => {
    expect(parseDecision('sure thing')).toBeNull();
    expect(parseDecision('{"action":"merge"}')).toBeNull();
  });
});

describe('replyRefusal', () => {
  it('passes a short first-person reply', () => {
    expect(replyRefusal('yeah that one is mine, looking at it today', ME.names)).toBeNull();
  });

  it('refuses empty, long, third-person and self-described automated replies', () => {
    expect(replyRefusal('', ME.names)).toMatch(/empty/);
    expect(replyRefusal('Robin will look at this', ME.names)).toMatch(/third person/);
    expect(replyRefusal('this is an automated reply', ME.names)).toMatch(/automated/);
  });

  it('refuses a reply the humanizer rule catches', () => {
    expect(replyRefusal('fixed on develop — should be green now', ME.names)).toMatch(/humanizer rule refused it/);
    expect(replyRefusal('that fix is crucial for the deposit screen', ME.names)).toMatch(/humanizer rule refused it/);
  });

  it('refuses a reply over the comment check word ceiling, and allows a long one under it', () => {
    const over = `${'word '.repeat(161)}`.trim();
    expect(replyRefusal(over, ME.names)).toMatch(/161 words of prose, over the 160-word ceiling/);
    // 900 characters, well past the old 700-character rule, but inside the word ceiling:
    // words are the only length rule on a comment now.
    const longButFine = `${'word '.repeat(150)}`.trim();
    expect(longButFine.length).toBeGreaterThan(700);
    expect(replyRefusal(longButFine, ME.names)).toBeNull();
  });
});

describe('runFeedActivity', () => {
  it('posts a safe reply to a mention once, and never again for the same comment', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('reply', 'yeah it is on develop now') });
    const first = await runFeedActivity(h.deps);
    expect(first.replied).toEqual(['ABC-1']);
    expect(h.posts).toEqual([{ ticket: 'ABC-1', body: 'yeah it is on develop now' }]);
    expect(h.rows.some((row) => row['event'] === 'feed.replied')).toBe(true);

    await runFeedActivity(h.deps);
    expect(h.posts).toHaveLength(1);
    expect(h.reasoner).toHaveBeenCalledTimes(1);
  });

  it('skips comments written before the feed started and comments the operator wrote', async () => {
    const h = harness({
      board: [issue({ comments: [
        comment({ id: 'old', created: START - 1, mentions: ['acc-me'] }),
        comment({ id: 'mine', authorAccountId: 'acc-me', body: 'Robin here' }),
      ] })],
      reply: decision('reply', 'x'),
    });
    const result = await runFeedActivity(h.deps);
    expect(result.considered).toBe(0);
    expect(h.reasoner).not.toHaveBeenCalled();
    expect(h.posts).toHaveLength(0);
  });

  it('sends a comment to the lane already working the ticket instead of answering it', async () => {
    const h = harness({
      board: [issue({ assigneeAccountId: 'acc-me', comments: [comment({ body: 'also fix the hover colour' })] })],
      items: [{ id: 'Q-1', ticket: 'ABC-1', state: 'running', runKey: 'run-abc-1' }],
    });
    const result = await runFeedActivity(h.deps);
    expect(result.sent).toEqual(['ABC-1']);
    expect(h.sends).toEqual([{ runKey: 'run-abc-1', text: 'Pat Doe commented on ABC-1: also fix the hover colour' }]);
    expect(h.reasoner).not.toHaveBeenCalled();
  });

  it('raises a deferred comment as a question, and posts the answer once when it is answered', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'], body: 'should we ship this friday?' })] })], reply: decision('defer', 'I think friday works') });
    const result = await runFeedActivity(h.deps);
    expect(result.deferred).toEqual(['ABC-1']);
    expect(h.posts).toHaveLength(0);
    const [entry] = h.inbox.open();
    expect(entry?.runs).toEqual([FEED_RUN]);
    expect(entry?.ticket).toBe('ABC-1');
    expect(entry?.options).toEqual(['I think friday works', LEAVE_OPTION]);
    expect(entry?.question).toContain('should we ship this friday?');

    h.inbox.answer(entry!.key, 'friday works for me');
    const second = await runFeedActivity(h.deps);
    expect(second.answered).toEqual(['ABC-1']);
    expect(h.posts).toEqual([{ ticket: 'ABC-1', body: 'friday works for me' }]);
    await runFeedActivity(h.deps);
    expect(h.posts).toHaveLength(1);
  });

  it('posts nothing when the question is answered with the leave option', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('defer', 'maybe') });
    await runFeedActivity(h.deps);
    const [entry] = h.inbox.open();
    h.inbox.answer(entry!.key, LEAVE_OPTION);
    await runFeedActivity(h.deps);
    expect(h.posts).toHaveLength(0);
    expect(h.rows.some((row) => row['event'] === 'feed.left')).toBe(true);
  });

  it('defers, never ignores, an unmarked comment the reasoner drafted an answer for but did not call directed', async () => {
    // `action` and `directed` are two independent lines out of one turn. A model that
    // contradicts itself used to lose the draft entirely; the contradiction now goes to
    // a person with the draft attached.
    const h = harness({ board: [issue({ comments: [comment({ body: 'lgtm' })] })], reply: decision('reply', 'thanks', 'no') });
    const result = await runFeedActivity(h.deps);
    expect(result.deferred).toEqual(['ABC-1']);
    expect(h.posts).toHaveLength(0);
    expect(h.inbox.open()).toHaveLength(1);
  });

  it('still ignores an unmarked comment the reasoner explicitly decides to ignore', async () => {
    const h = harness({ board: [issue({ comments: [comment({ body: 'lgtm' })] })], reply: decision('ignore', '', 'no') });
    const result = await runFeedActivity(h.deps);
    expect(result.ignored).toEqual(['ABC-1']);
    expect(h.inbox.open()).toHaveLength(0);
  });

  it('answers an unmarked comment the reasoner says is aimed at the operator', async () => {
    const h = harness({ board: [issue({ comments: [comment({ body: 'whoever owns the app login, is this known?' })] })], reply: decision('reply', 'yep, known, on it') });
    const result = await runFeedActivity(h.deps);
    expect(result.replied).toEqual(['ABC-1']);
  });

  it('defers a comment the reasoner could not decide on, marked or unmarked', async () => {
    // A reasoner that timed out has decided nothing. Recording that as ignored made a
    // transient outage a permanent verdict on a comment nobody would ever see again.
    const marked = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: new Error('timed out') });
    expect((await runFeedActivity(marked.deps)).deferred).toEqual(['ABC-1']);
    expect(marked.inbox.open()).toHaveLength(1);

    const unmarked = harness({ board: [issue({ comments: [comment()] })], reply: new Error('timed out') });
    expect((await runFeedActivity(unmarked.deps)).deferred).toEqual(['ABC-1']);
    expect(unmarked.inbox.open()).toHaveLength(1);
  });

  it('defers instead of posting a reply that fails the safety checks or that Jira refuses', async () => {
    const unsafe = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('reply', 'Robin will handle it') });
    expect((await runFeedActivity(unsafe.deps)).deferred).toEqual(['ABC-1']);
    expect(unsafe.posts).toHaveLength(0);

    const refused = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('reply', 'on it'), postOk: false });
    expect((await runFeedActivity(refused.deps)).deferred).toEqual(['ABC-1']);
    // One post, one rewording, one more post, then the inbox.
    expect(refused.posts).toHaveLength(2);
  });

  it('treats a new ticket whose description names the operator as something to resolve', async () => {
    const h = harness({ board: [issue({ created: LATER, description: 'Robin can you take a look at the login?' })], reply: decision('defer', 'sure') });
    const result = await runFeedActivity(h.deps);
    expect(result.deferred).toEqual(['ABC-1']);
  });

  it('never posts twice when a write throws mid-resolution', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('reply', 'on it') });
    h.deps.post = async () => { throw new Error('socket hang up'); };
    expect((await runFeedActivity(h.deps)).failed).toEqual(['ABC-1']);
    const post = vi.fn(async () => ({ ok: true }));
    h.deps.post = post;
    await runFeedActivity(h.deps);
    expect(post).not.toHaveBeenCalled();
  });

  it('has the comment claimed on disk before the post runs, so a crash mid-post cannot double it', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('reply', 'on it') });
    let seenAtPost: string | undefined;
    h.deps.post = async () => {
      seenAtPost = h.deps.ledger.read().handled['c1']?.outcome;
      return { ok: true };
    };
    await runFeedActivity(h.deps);
    expect(seenAtPost).toBe('claimed');
  });

  it('widens its look-back to cover the time since the last poll', async () => {
    const h = harness({ now: LATER });
    await runFeedActivity(h.deps);
    expect(h.jql[0]).toBe(feedJql('ABC', 2));
    h.deps.now = () => LATER + 10 * 60_000;
    await runFeedActivity(h.deps);
    expect(h.jql[1]).toBe(feedJql('ABC', 12));
  });
});

describe('fileFeedLedger', () => {
  it('round-trips and treats a corrupt file as starting now', async () => {
    const { writeFileSync } = await import('node:fs');
    const path = join(mkdtempSync(join(tmpdir(), 'feed-ledger-')), 'jira-feed.json');
    const store = fileFeedLedger(path, () => START);
    store.write({ startedAt: 5, lastPollAt: 6, handled: { c1: { at: START, ticket: 'ABC-1', outcome: 'replied' } }, answered: ['k@1'], posted: ['p1'] });
    expect(store.read()).toEqual({ startedAt: 5, lastPollAt: 6, handled: { c1: { at: START, ticket: 'ABC-1', outcome: 'replied' } }, answered: ['k@1'], posted: ['p1'] });
    writeFileSync(path, '{nope', 'utf8');
    expect(store.read().startedAt).toBe(START);
  });
});

describe('fetchFeedIssues', () => {
  it('reads comments with their mentions, and re-reads a truncated thread from the issue', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/search/jql')) {
        return new Response(JSON.stringify({
          isLast: true,
          issues: [{
            key: 'ABC-1',
            fields: {
              summary: 's', status: { name: 'Backlog' }, assignee: { accountId: 'acc-me', displayName: 'Robin Roe' },
              reporter: { accountId: 'acc-pat', displayName: 'Pat Doe' }, created: '2026-09-14T10:00:00.000+0000', updated: '2026-09-14T10:01:00.000+0000',
              comment: { total: 2, comments: [{ id: '1', author: { accountId: 'acc-pat' }, body: 'old', created: '2026-09-14T10:00:30.000+0000' }] },
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ comments: [
        { id: '2', author: { accountId: 'acc-pat', displayName: 'Pat Doe' }, created: '2026-09-14T10:01:00.000+0000', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'acc-me', text: '@Robin' } }] }] } },
        { id: '1', author: { accountId: 'acc-pat' }, body: 'old', created: '2026-09-14T10:00:30.000+0000' },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;

    const [found] = await fetchFeedIssues({ site: 'https://site', email: 'e', token: 't', fetchFn }, feedJql('ABC', 2));
    expect(calls[1]).toContain('/issue/ABC-1/comment');
    expect(found?.comments.map((row) => row.id)).toEqual(['1', '2']);
    expect(found?.comments[1]?.mentions).toEqual(['acc-me']);
    expect(found?.assigneeAccountId).toBe('acc-me');
  });
});

// The operator's own comments, allowed for a timed self-test (Aaron, 2026-09-14). The feed
// posts as the operator too, so the one thing that must never happen is it answering a
// reply it wrote itself.
describe('self-test: the operator commenting to themself', () => {
  function selfComment(extra: Partial<FeedComment> = {}): FeedComment {
    return comment({ authorAccountId: 'acc-me', authorName: 'Robin Roe', body: 'what does this ticket change?', ...extra });
  }

  it('answers the operator\'s own comment while the switch is on, and records how long it took', async () => {
    const h = harness({
      board: [issue({ reporterAccountId: 'acc-me', comments: [selfComment({ created: LATER })] })],
      reply: decision('reply', 'it makes the login button blue'),
      now: LATER + 7_000,
    });
    h.deps.selfTest = () => true;
    h.deps.post = async (ticket, body) => { h.posts.push({ ticket, body }); return { ok: true, id: 'posted-1' }; };

    const result = await runFeedActivity(h.deps);
    expect(result.replied).toEqual(['ABC-1']);
    const row = h.rows.find((r) => r['event'] === 'feed.replied');
    expect(row?.['latencyMs']).toBe(7_000);
    expect(row?.['selfTest']).toBe(true);
  });

  it('never answers a reply the feed posted itself', async () => {
    const own = selfComment({ id: 'c1', created: LATER });
    const board = [issue({ reporterAccountId: 'acc-me', comments: [own] })];
    const h = harness({ board, reply: decision('reply', 'it makes the login button blue') });
    h.deps.selfTest = () => true;
    h.deps.post = async (ticket, body) => {
      h.posts.push({ ticket, body });
      board[0]!.comments.push(selfComment({ id: 'posted-1', body, created: LATER + 1 }));
      return { ok: true, id: 'posted-1' };
    };

    await runFeedActivity(h.deps);
    await runFeedActivity(h.deps);
    await runFeedActivity(h.deps);
    expect(h.posts).toHaveLength(1);
    expect(h.reasoner).toHaveBeenCalledTimes(1);
  });

  it('ignores the operator\'s own comments while the switch is off', async () => {
    const h = harness({ board: [issue({ reporterAccountId: 'acc-me', comments: [selfComment()] })], reply: decision('reply', 'x') });
    h.deps.selfTest = () => false;
    await runFeedActivity(h.deps);
    expect(h.reasoner).not.toHaveBeenCalled();
    expect(h.posts).toHaveLength(0);
  });

  it('caps self-test replies per ticket, deferring the rest', async () => {
    const comments = Array.from({ length: 12 }, (_, n) => selfComment({ id: `s${n}`, created: LATER + n }));
    const h = harness({ board: [issue({ reporterAccountId: 'acc-me', comments })], reply: decision('reply', 'yep') });
    h.deps.selfTest = () => true;
    let n = 0;
    h.deps.post = async (ticket, body) => { h.posts.push({ ticket, body }); n += 1; return { ok: true, id: `p${n}` }; };
    const result = await runFeedActivity(h.deps);
    expect(h.posts).toHaveLength(10);
    expect(result.deferred).toHaveLength(2);
  });
});

// Measured live 2026-09-14: two comments arriving together, handled one after the other,
// took 6.4 s and 15.6 s; the second waited on the first's model call.
describe('comments in one pass are handled together', () => {
  it('starts every comment\'s decision before the first one finishes', async () => {
    const comments = [comment({ id: 'a', mentions: ['acc-me'] }), comment({ id: 'b', mentions: ['acc-me'] }), comment({ id: 'c', mentions: ['acc-me'] })];
    const h = harness({ board: [issue({ comments })] });
    let inFlight = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    h.deps.reasoner = {
      call: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        inFlight -= 1;
        return { text: decision('ignore') };
      },
    };
    const run = runFeedActivity(h.deps);
    for (let spins = 0; spins < 50 && releases.length < 3; spins += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(peak).toBe(3);
    releases.forEach((release) => release());
    const result = await run;
    expect(result.ignored).toHaveLength(3);
  });
});

// Measured live 2026-09-14: a correct reply ("just the app") was refused by the comment
// readability check for a filler word and fell to the inbox, when one rewording would
// have posted it.
describe('a reply refused by the comment check is reworded', () => {
  it('asks the reasoner again with the refusal, and posts the reworded reply', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'], body: 'web too or only the app?' })] })] });
    const prompts: string[] = [];
    const replies = [decision('reply', 'just the app'), decision('reply', 'only the app')];
    h.deps.reasoner = { call: async ({ prompt }) => {
      if (isCriticPrompt(prompt)) return { text: critique() };
      prompts.push(prompt);
      return { text: replies[Math.min(prompts.length - 1, replies.length - 1)]! };
    } };
    h.deps.post = async (ticket, body) => {
      h.posts.push({ ticket, body });
      return body.includes('just') ? { ok: false, body: 'readability refused this comment: banned word(s) in prose: just' } : { ok: true, id: 'p1' };
    };

    const result = await runFeedActivity(h.deps);
    expect(result.replied).toEqual(['ABC-1']);
    // Jira's own refusal still drives a reword; the first body is the one it refused.
    expect(h.posts.map((post) => post.body)).toEqual(['just the app', 'only the app']);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('banned word(s) in prose: just');
  });

  it('defers when the reworded reply is refused too', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('reply', 'the app only') });
    h.deps.post = async (ticket, body) => { h.posts.push({ ticket, body }); return { ok: false, body: 'readability refused this comment: banned word(s) in prose: just' }; };
    const result = await runFeedActivity(h.deps);
    expect(result.deferred).toEqual(['ABC-1']);
    expect(h.posts.length).toBeGreaterThanOrEqual(1);
  });
});

// Measured live 2026-09-14: the reword call fixed the wording, but the model answered in
// the bare line form the prompt asks for, the reasoner demanded a JSON wrapper, and the
// comment fell to the inbox. The decision is text; parseDecision reads both forms.
describe('the decision call asks for a text reply', () => {
  it('passes replyShape text on the first decision and on the rewording', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })] });
    const shapes: (string | undefined)[] = [];
    const replies = [decision('reply', 'just the app'), decision('reply', 'only the app')];
    h.deps.reasoner = { call: async (input) => {
      if (isCriticPrompt(input.prompt)) return { text: critique() };
      shapes.push(input.replyShape);
      return { text: replies[Math.min(shapes.length - 1, replies.length - 1)]! };
    } };
    h.deps.post = async (ticket, body) => {
      h.posts.push({ ticket, body });
      return body.includes('just') ? { ok: false, body: 'readability refused this comment: banned word(s) in prose: just' } : { ok: true, id: 'p1' };
    };
    const result = await runFeedActivity(h.deps);
    expect(shapes).toEqual(['text', 'text']);
    expect(result.replied).toEqual(['ABC-1']);
  });

  it('names the words the comment check refuses, so the first reply avoids them', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })] });
    let prompt = '';
    h.deps.reasoner = { call: async (input) => { prompt = input.prompt; return { text: decision('ignore') }; } };
    h.deps.avoidWords = () => ['just', 'really'];
    await runFeedActivity(h.deps);
    expect(prompt).toContain('never use these words: just, really');
  });
});

// ---------------------------------------------------------------------------------------
// The gauntlet, wired (2026-09-18)

describe('the gauntlet runs before a reply posts', () => {
  it('posts the draft the critic picked, after the rounds it took', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] }), barComment()] })] });
    const drafts = ['first try', 'second try'];
    let builds = 0;
    let critiques = 0;
    h.deps.reasoner = { call: async ({ prompt }) => {
      if (isCriticPrompt(prompt)) {
        critiques += 1;
        return { text: critiques === 1 ? critique({ verdict: 'theirs', gap: 'reads generated' }) : critique() };
      }
      builds += 1;
      return { text: decision('reply', drafts[Math.min(builds - 1, drafts.length - 1)]!) };
    } };
    const result = await runFeedActivity(h.deps);
    expect(result.replied).toEqual(['ABC-1']);
    expect(h.posts.map((p) => p.body)).toEqual(['second try']);
    expect(critiques).toBe(2);
  });

  it('defers with the best draft when the critic never picks ours', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] }), barComment()] })] });
    h.deps.reasoner = { call: async ({ prompt }) => ({
      text: isCriticPrompt(prompt)
        ? critique({ verdict: 'theirs', gap: 'still nothing in the thread supports it' })
        : decision('reply', 'a guess about the promote'),
    }) };
    const result = await runFeedActivity(h.deps);
    expect(result.replied).toEqual([]);
    expect(result.deferred).toEqual(['ABC-1']);
    // Nothing was posted, and the work is in the inbox rather than thrown away.
    expect(h.posts).toHaveLength(0);
    expect(h.inbox.all()[0]?.options?.[0]).toBe('a guess about the promote');
  });

  it('never posts a draft whose claims the critic cannot support, even when the voice wins', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] }), barComment()] })] });
    h.deps.reasoner = { call: async ({ prompt }) => ({
      text: isCriticPrompt(prompt)
        ? critique({ verdict: 'ours', supported: 'no', gap: 'the thread never mentions that file' })
        : decision('reply', 'fixed in baseQuery.ts'),
    }) };
    const result = await runFeedActivity(h.deps);
    expect(h.posts).toHaveLength(0);
    expect(result.deferred).toEqual(['ABC-1']);
  });

  it('gives the critic real comments by other people and never our own', async () => {
    const board = [issue({
      comments: [
        comment({ mentions: ['acc-me'] }),
        comment({ id: 'c2', authorAccountId: 'acc-me', authorName: 'Robin Roe', body: 'a long comment of my own that would be a terrible thing to compare our draft against' }),
        comment({ id: 'c3', authorAccountId: 'acc-pat', authorName: 'Pat Doe', body: 'retested on the latest build and the grey button is gone now, closing this one out' }),
      ],
    })];
    const h = harness({ board });
    let criticPrompt = '';
    h.deps.reasoner = { call: async ({ prompt }) => {
      if (isCriticPrompt(prompt)) { criticPrompt = prompt; return { text: critique() }; }
      return { text: decision('reply', 'on it') };
    } };
    await runFeedActivity(h.deps);
    const barSection = criticPrompt.split('Here are real comments other people wrote')[1]?.split('Here is a candidate answer')[0] ?? '';
    expect(barSection).toContain('retested on the latest build');
    // Our own comments are in the thread (the critic needs the whole thread) but never in
    // the bar: comparing our draft against our own writing proves nothing.
    expect(barSection).not.toContain('a terrible thing to compare');
    expect(criticPrompt).toContain('a terrible thing to compare');
  });
});

describe('claiming a ticket from a comment', () => {
  function claimHarness(over: { claimText?: string; assignOk?: boolean } = {}) {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'], body: 'can you take this one?' }), barComment()] })] });
    const assigns: { ticket: string; accountId: string }[] = [];
    const queued: string[] = [];
    h.deps.reasoner = { call: async ({ prompt }) => {
      if (isCriticPrompt(prompt)) return { text: critique() };
      if (prompt.includes('Pick one action.')) {
        return { text: over.claimText ?? 'ACTION: claim\nREPO: acme/app\nWHY: one screen\nREPLY: taking this' };
      }
      return { text: decision('reply', 'taking this') };
    } };
    h.deps.claim = {
      repos: () => ['acme/app'],
      assign: async (ticket, accountId) => { assigns.push({ ticket, accountId }); return over.assignOk === false ? { ok: false, status: 403, body: 'no permission' } : { ok: true, status: 204 }; },
      enqueue: (ticket) => { queued.push(ticket); },
    };
    return { h, assigns, queued };
  }

  it('replies, assigns to the operator and queues the ticket', async () => {
    const { h, assigns, queued } = claimHarness();
    const result = await runFeedActivity(h.deps);
    expect(result.claimed).toEqual(['ABC-1']);
    expect(h.posts.map((p) => p.body)).toEqual(['taking this']);
    expect(assigns).toEqual([{ ticket: 'ABC-1', accountId: 'acc-me' }]);
    expect(queued).toEqual(['ABC-1']);
  });

  it('defers rather than queueing when the assign is refused', async () => {
    const { h, queued } = claimHarness({ assignOk: false });
    const result = await runFeedActivity(h.deps);
    expect(result.claimed).toEqual([]);
    expect(result.deferred).toEqual(['ABC-1']);
    // The comment is public, the queue owns nothing, and a person is told which stage stopped.
    expect(h.posts).toHaveLength(1);
    expect(queued).toEqual([]);
  });

  it('replies without claiming when the decision is answer', async () => {
    const { h, assigns, queued } = claimHarness({ claimText: 'ACTION: answer\nREPO: none\nWHY: a question\nREPLY: taking this' });
    const result = await runFeedActivity(h.deps);
    expect(result.replied).toEqual(['ABC-1']);
    expect(result.claimed).toEqual([]);
    expect(assigns).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('never claims a ticket the queue is already working', async () => {
    const { h, queued } = claimHarness();
    h.deps.queueItems = () => ([{ ticket: 'ABC-1', state: 'done' }] as QueueItem[]);
    const result = await runFeedActivity(h.deps);
    expect(result.claimed).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('does nothing different when no claim wiring is present', async () => {
    const h = harness({ board: [issue({ comments: [comment({ mentions: ['acc-me'] })] })], reply: decision('reply', 'on it') });
    const result = await runFeedActivity(h.deps);
    expect(result.replied).toEqual(['ABC-1']);
    expect(result.claimed).toEqual([]);
  });
});
