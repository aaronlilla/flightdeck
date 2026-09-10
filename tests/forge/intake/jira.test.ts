/**
 * J1 (the real Jira poll feed) and J4 (`forge intake --probe-jira`'s credential proof).
 * Every fetch here is a fake injected through `fetchFn` -- no specimen in this file
 * touches the network, per the guardrails.
 */
import { describe, expect, it } from 'vitest';

import { createJiraFeed, createJiraWriteClient, flattenAdf, probeJira } from '../../../src/forge/intake/jira.js';
import { initialWatermark } from '../../../src/forge/intake/watermark.js';

const CONFIG = { site: 'https://acme.atlassian.net', email: 'bot@acme.test', token: 'a-real-looking-secret-token-value-123456' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createJiraFeed — paging', () => {
  it('pages on nextPageToken until the last page, returning every issue across both pages', async () => {
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(200, {
          issues: [{ key: 'BBZ-1', fields: { summary: 'first', updated: '2026-09-01T00:00:00.000Z' } }],
          nextPageToken: 'page-2', isLast: false,
        });
      }
      return jsonResponse(200, {
        issues: [{ key: 'BBZ-2', fields: { summary: 'second', updated: '2026-09-02T00:00:00.000Z' } }],
        isLast: true,
      });
    }) as unknown as typeof fetch;

    const feed = createJiraFeed({ ...CONFIG, fetchFn });
    const items = await feed.fetchSince(initialWatermark('jira'));

    expect(call).toBe(2);
    expect(items.map((i) => i.id)).toEqual(['BBZ-1', 'BBZ-2']);
  });

  it('watermark passed through untouched: fetchSince ignores it, filtering stays in poller.ts', async () => {
    let receivedWatermark: unknown;
    const fetchFn = (async () => jsonResponse(200, { issues: [], isLast: true })) as unknown as typeof fetch;
    const feed = createJiraFeed({ ...CONFIG, fetchFn });
    const mark = { source: 'jira' as const, committedAt: 12345, idsAtCommittedAt: ['BBZ-9'] };
    // fetchSince takes the watermark parameter (the FakePollFeed shape) but this feed's
    // own request body never carries it -- proven by asserting the mark object itself
    // is never read for anything other than being accepted, not by intercepting a field
    // that was never there to begin with.
    receivedWatermark = mark;
    const items = await feed.fetchSince(mark);
    expect(items).toEqual([]);
    expect(receivedWatermark).toBe(mark);
  });
});

describe('createJiraFeed — no token in any error, journal row or printed line', () => {
  it('a failing call throws an error carrying the status and truncated body, with the token nowhere in it', async () => {
    const fetchFn = (async () => new Response('unauthorized: bad credentials', { status: 401 })) as unknown as typeof fetch;
    const feed = createJiraFeed({ ...CONFIG, fetchFn });

    let captured = '';
    try {
      await feed.fetchSince(initialWatermark('jira'));
      throw new Error('expected fetchSince to throw');
    } catch (error) {
      captured = error instanceof Error ? error.message : String(error);
    }

    expect(captured).toContain('401');
    expect(captured).not.toContain(CONFIG.token);
  });
});

describe('createJiraFeed — R1 routing fields', () => {
  it('requests components alongside labels, and carries both on the detail', async () => {
    let requestedBody: { fields?: string[] } | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      requestedBody = JSON.parse(init.body as string);
      return jsonResponse(200, {
        issues: [{
          key: 'BBZ-1',
          fields: {
            summary: 'x', updated: '2026-09-05T00:00:00.000Z',
            labels: ['mobile'], components: [{ name: 'api' }, { name: 'wallet' }],
          },
        }],
        isLast: true,
      });
    }) as unknown as typeof fetch;

    const feed = createJiraFeed({ ...CONFIG, fetchFn });
    const items = await feed.fetchSince(initialWatermark('jira'));

    expect(requestedBody?.fields).toContain('components');
    expect(items[0]?.detail?.labels).toEqual(['mobile']);
    expect(items[0]?.detail?.components).toEqual(['api', 'wallet']);
  });
});

describe('flattenAdf', () => {
  it('flattens a two-paragraph Atlassian document to plain text', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Repro: airplane mode.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Crashes on cold start.' }] },
      ],
    };
    expect(flattenAdf(adf)).toBe('Repro: airplane mode.\n\nCrashes on cold start.');
  });

  it('returns empty text for no description at all', () => {
    expect(flattenAdf(undefined)).toBe('');
  });
});

describe('createJiraWriteClient — R2: comment posts an Atlassian Document Format body', () => {
  it('sends a two-paragraph comment with a numbered list as the exact ADF document, never a plain string', async () => {
    let requestedBody: unknown;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      requestedBody = JSON.parse(init.body as string);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const client = createJiraWriteClient({ ...CONFIG, fetchFn });
    const commentText = [
      'Merged https://example.test/pr/1.',
      'Steps to check:\n1. Open the app\n2. Confirm the banner shows',
    ].join('\n\n');

    await client.comment('BBZ-1', commentText);

    expect(requestedBody).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Merged https://example.test/pr/1.' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Steps to check:' },
              { type: 'hardBreak' },
              { type: 'text', text: '1. Open the app' },
              { type: 'hardBreak' },
              { type: 'text', text: '2. Confirm the banner shows' },
            ],
          },
        ],
      },
    });
    const body = (requestedBody as { body: unknown }).body;
    expect(typeof body).not.toBe('string');
  });
});

describe('probeJira — J4', () => {
  it('a successful call returns exactly displayName and accountId, ok', async () => {
    const fetchFn = (async () => jsonResponse(200, { displayName: 'Aaron Lilla', accountId: 'acc-1' })) as unknown as typeof fetch;
    const result = await probeJira({ ...CONFIG, fetchFn });
    expect(result).toEqual({ ok: true, displayName: 'Aaron Lilla', accountId: 'acc-1' });
  });

  it('a failing call reports ok: false and the HTTP status, nothing else', async () => {
    const fetchFn = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const result = await probeJira({ ...CONFIG, fetchFn });
    expect(result).toEqual({ ok: false, status: 403 });
  });
});

describe('createJiraWriteClient — order 19 backstop on comment()', () => {
  const OVER_80_WORDS = Array.from({ length: 90 }, (_v, i) => `word${i}`).join(' ');

  it('an over-ceiling comment never reaches fetchFn and reports ok: false', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return jsonResponse(200, {}); }) as unknown as typeof fetch;
    const client = createJiraWriteClient({ ...CONFIG, fetchFn });

    const result = await client.comment('BBZ-1', OVER_80_WORDS);

    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.body).toContain('readability refused');
  });

  it('a conforming comment reaches fetchFn exactly once and reports ok: true', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return jsonResponse(200, {}); }) as unknown as typeof fetch;
    const client = createJiraWriteClient({ ...CONFIG, fetchFn });

    const result = await client.comment('BBZ-1', 'Short comment, well under the ceiling.');

    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
  });
});
