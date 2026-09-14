/**
 * R-101 escape, 2026-09-14: the Jira feed queued a ticket two seconds after it was
 * created and planned it on that tick. The planner's key search came back empty (the
 * search index had not caught up), so the interview saw a bare key and asked a person
 * to paste the ticket. Reading the issue itself does not depend on the index.
 */
import { describe, expect, it } from 'vitest';

import { readTicketDetail } from '../../../src/forge/intake/jira.js';

const ISSUE = {
  key: 'ABC-9',
  fields: {
    summary: 'Add one line', description: 'Create docs/x.md with one line.',
    status: { name: 'Backlog', statusCategory: { key: 'new' } }, issuetype: { name: 'Task' },
    priority: { name: 'Low' }, labels: ['hold-me'], components: [], updated: '2026-09-14T07:47:23.034-0700',
  },
};

function indexNotCaughtUp(): typeof fetch {
  return (async (url: string) => {
    if (url.includes('/search/jql')) return new Response(JSON.stringify({ issues: [], isLast: true }), { status: 200 });
    if (url.includes('/issue/ABC-9')) return new Response(JSON.stringify(ISSUE), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('readTicketDetail', () => {
  it('reads a ticket the search index has not caught up with yet', async () => {
    const detail = await readTicketDetail({ site: 'https://site', email: 'e', token: 't', fetchFn: indexNotCaughtUp() }, 'ABC-9');
    expect(detail).toMatchObject({ summary: 'Add one line', description: 'Create docs/x.md with one line.', labels: ['hold-me'], statusCategory: 'new' });
  });

  it('throws naming the ticket when Jira cannot return it, rather than planning a bare key', async () => {
    await expect(readTicketDetail({ site: 'https://site', email: 'e', token: 't', fetchFn: indexNotCaughtUp() }, 'ABC-404'))
      .rejects.toThrow(/ABC-404/);
  });
});
