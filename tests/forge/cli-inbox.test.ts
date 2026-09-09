/**
 * `forge inbox`: proves `classifyInbox`'s three buckets against a fixed set of fixture
 * issues, and `forge inbox` (the CLI command) against a faked Jira `fetch`.
 *
 * Named `cli-inbox.test.ts` rather than `inbox.test.ts` because that file already tests
 * `src/forge/inbox.ts` (the worker's own ask/answer inbox) -- a different `inbox`
 * entirely from this one, which is Jira triage.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { forge } from '../../src/forge/cli.js';
import { classifyInbox, type InboxIssue } from '../../src/forge/intake/inbox.js';

const ME = 'acc-me';
const NOW = Date.parse('2026-09-08T12:00:00Z');
const DAY = 86_400_000;

function issue(overrides: Partial<InboxIssue>): InboxIssue {
  return {
    key: 'BBZ-0', summary: 'summary', status: 'To Do',
    assigneeAccountId: null, assigneeDisplayName: null, reporterAccountId: null,
    updated: NOW, comments: [],
    ...overrides,
  };
}

describe('classifyInbox', () => {
  it('puts a ticket whose last comment is not mine into needsReply', () => {
    const fixture = [issue({
      key: 'BBZ-1', assigneeAccountId: ME, assigneeDisplayName: 'Me',
      comments: [{ authorAccountId: 'acc-other', authorDisplayName: 'Someone', body: 'ping', created: NOW - DAY }],
    })];
    const buckets = classifyInbox(fixture, { accountId: ME }, NOW);
    expect(buckets.needsReply.map((r) => r.key)).toEqual(['BBZ-1']);
    expect(buckets.awaitingOthers).toEqual([]);
  });

  it('puts a ticket whose last comment is mine, assigned to someone else, into awaitingOthers', () => {
    const fixture = [issue({
      key: 'BBZ-2', assigneeAccountId: 'acc-other', assigneeDisplayName: 'Someone',
      comments: [{ authorAccountId: ME, authorDisplayName: 'Me', body: 'over to you', created: NOW - DAY }],
    })];
    const buckets = classifyInbox(fixture, { accountId: ME }, NOW);
    expect(buckets.awaitingOthers.map((r) => r.key)).toEqual(['BBZ-2']);
    expect(buckets.needsReply).toEqual([]);
  });

  it('does not put a ticket whose last comment is mine and still assigned to me into either bucket', () => {
    const fixture = [issue({
      key: 'BBZ-3', assigneeAccountId: ME, assigneeDisplayName: 'Me',
      comments: [{ authorAccountId: ME, authorDisplayName: 'Me', body: 'noted', created: NOW - DAY }],
    })];
    const buckets = classifyInbox(fixture, { accountId: ME }, NOW);
    expect(buckets.needsReply).toEqual([]);
    expect(buckets.awaitingOthers).toEqual([]);
  });

  it('flags status drift: assigned to me, a merged PR is mentioned, status has not moved', () => {
    const fixture = [issue({
      key: 'BBZ-4', status: 'In Progress', assigneeAccountId: ME, assigneeDisplayName: 'Me',
      comments: [{ authorAccountId: ME, authorDisplayName: 'Me', body: 'PR #42 merged', created: NOW - DAY }],
    })];
    const buckets = classifyInbox(fixture, { accountId: ME }, NOW);
    expect(buckets.statusDrift.map((r) => r.key)).toEqual(['BBZ-4']);
  });

  it('does not flag status drift once the status already moved to In Review', () => {
    const fixture = [issue({
      key: 'BBZ-5', status: 'In Review', assigneeAccountId: ME, assigneeDisplayName: 'Me',
      comments: [{ authorAccountId: ME, authorDisplayName: 'Me', body: 'PR #42 merged', created: NOW - DAY }],
    })];
    const buckets = classifyInbox(fixture, { accountId: ME }, NOW);
    expect(buckets.statusDrift).toEqual([]);
  });

  it('handles mention markup in a comment body without throwing', () => {
    const fixture = [issue({
      key: 'BBZ-6', assigneeAccountId: ME, assigneeDisplayName: 'Me',
      comments: [{
        authorAccountId: 'acc-other', authorDisplayName: 'Someone',
        body: '[~accountid:acc-other] can you check this? PR #7 merged already', created: NOW - DAY,
      }],
    })];
    const buckets = classifyInbox(fixture, { accountId: ME }, NOW);
    expect(buckets.needsReply.map((r) => r.key)).toEqual(['BBZ-6']);
  });

  it('ignores a ticket with no comments at all', () => {
    const fixture = [issue({ key: 'BBZ-7', assigneeAccountId: ME, assigneeDisplayName: 'Me', comments: [] })];
    const buckets = classifyInbox(fixture, { accountId: ME }, NOW);
    expect(buckets.needsReply).toEqual([]);
    expect(buckets.awaitingOthers).toEqual([]);
    expect(buckets.statusDrift).toEqual([]);
  });

  it('handles an empty issue list', () => {
    const buckets = classifyInbox([], { accountId: ME }, NOW);
    expect(buckets).toEqual({ needsReply: [], awaitingOthers: [], statusDrift: [] });
  });
});

describe('forge inbox', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'forge-cli-inbox-'));
    process.env['FORGE_HOME'] = home;
    process.env['FORGE_JIRA_SITE'] = 'https://example.atlassian.net';
    process.env['FORGE_JIRA_EMAIL'] = 'me@example.com';
    process.env['FORGE_JIRA_TOKEN'] = 'tok';
  });

  it('refuses with the exact missing-credential reason when nothing is configured', async () => {
    delete process.env['FORGE_JIRA_SITE'];
    delete process.env['FORGE_JIRA_EMAIL'];
    delete process.env['FORGE_JIRA_TOKEN'];
    const result = await forge(['inbox']);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('missing FORGE_JIRA_SITE');
  });

  it('prints grouped plain text against a faked feed', async () => {
    const fetchFn = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/myself')) {
        return new Response(JSON.stringify({ displayName: 'Me', accountId: ME }), { status: 200 });
      }
      const body = {
        issues: [{
          key: 'BBZ-9',
          fields: {
            summary: 'A ticket', status: { name: 'To Do' },
            assignee: { accountId: ME, displayName: 'Me' }, reporter: { accountId: 'acc-other' },
            updated: new Date(NOW - DAY).toISOString(),
            comment: { comments: [{ author: { accountId: 'acc-other', displayName: 'Someone' }, body: 'ping', created: new Date(NOW - DAY).toISOString() }] },
          },
        }],
        isLast: true,
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const result = await forge(['inbox'], { fetchFn });
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toContain('needs reply (1)');
    expect(result.lines.join('\n')).toContain('BBZ-9');
  });

  it('dumps JSON with --json', async () => {
    const fetchFn = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/myself')) {
        return new Response(JSON.stringify({ displayName: 'Me', accountId: ME }), { status: 200 });
      }
      return new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 });
    }) as typeof fetch;
    const result = await forge(['inbox', '--json'], { fetchFn });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.lines.join('\n')) as { needsReply: unknown[]; awaitingOthers: unknown[]; statusDrift: unknown[] };
    expect(parsed).toEqual({ needsReply: [], awaitingOthers: [], statusDrift: [] });
  });

  it('handles an empty page from the feed', async () => {
    const fetchFn = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/myself')) {
        return new Response(JSON.stringify({ displayName: 'Me', accountId: ME }), { status: 200 });
      }
      return new Response(JSON.stringify({ isLast: true }), { status: 200 });
    }) as typeof fetch;
    const result = await forge(['inbox'], { fetchFn });
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toContain('needs reply (0)');
  });
});
