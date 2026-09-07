/**
 * A.4/A.2: the production wiring queue.ts itself never touches -- the Jira and gh calls
 * `buildQueueRuntimeDeps` hands `advanceItem`. Every `fetch` and `gh` call here is a fake
 * (no network, no subprocess), the same discipline `tests/forge/intake/jira.test.ts`
 * already keeps.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { queueBackendHandoff, queueCommentOnPr } from '../../src/forge/queue-wire.ts';

const calls: { url: string; init?: RequestInit }[] = [];

function fakeFetch(status = 200): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('', { status });
  }) as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
  for (const name of ['FORGE_JIRA_SITE', 'FORGE_JIRA_EMAIL', 'FORGE_JIRA_TOKEN', 'FORGE_JIRA_BACKEND_OWNER_ACCOUNT', 'FORGE_GH_BACKEND_OWNER']) {
    delete process.env[name];
  }
});

describe('queueBackendHandoff', () => {
  it('does nothing when neither backend environment variable is set', async () => {
    await queueBackendHandoff()({ item: { ticket: 'BBMS-1', repo: 'acme/backend' } as never, pr: { no: 9 } });
    expect(calls).toEqual([]);
  });

  it('assigns the Jira ticket to the backend owner when the account and Jira config are present', async () => {
    process.env['FORGE_JIRA_SITE'] = 'https://acme.atlassian.net';
    process.env['FORGE_JIRA_EMAIL'] = 'bot@acme.com';
    process.env['FORGE_JIRA_TOKEN'] = 'token';
    process.env['FORGE_JIRA_BACKEND_OWNER_ACCOUNT'] = 'acc-joe';

    await queueBackendHandoff(() => ({
      site: 'https://acme.atlassian.net', email: 'bot@acme.com', token: 'token', fetchFn: fakeFetch(),
    }))({ item: { ticket: 'BBMS-1', repo: 'acme/backend' } as never, pr: { no: 9 } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/issue/BBMS-1/assignee');
  });
});

describe('queueCommentOnPr', () => {
  it('exists as a function ready to post through gh -- wiring proven by council/gh.test.ts', () => {
    expect(typeof queueCommentOnPr()).toBe('function');
  });
});
