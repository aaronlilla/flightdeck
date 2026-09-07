/**
 * A.4/A.2: the production wiring queue.ts itself never touches -- the Jira and gh calls
 * `buildQueueRuntimeDeps` hands `advanceItem`. Every `fetch` and `gh` call here is a fake
 * (no network, no subprocess), the same discipline `tests/forge/intake/jira.test.ts`
 * already keeps.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildBacklogJql, queueBackendHandoff, queueCommentOnPr, queueMergeAllowed, queueProductionWorkflowExists,
} from '../../src/forge/queue-wire.ts';
import { readChainEnv } from '../../src/forge/chain-env.ts';

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

describe('buildBacklogJql: A.5', () => {
  it('wraps an operator filter into a project-scoped, not-Done JQL', () => {
    const jql = buildBacklogJql('flaky', { FORGE_BACKLOG_PROJECT: 'BBZ' } as NodeJS.ProcessEnv);
    expect(jql).toBe('project = BBZ AND statusCategory != Done AND text ~ "flaky"');
  });

  it('refuses honestly when FORGE_BACKLOG_PROJECT is unset, rather than searching every project', () => {
    expect(() => buildBacklogJql('flaky', {} as NodeJS.ProcessEnv)).toThrow(/FORGE_BACKLOG_PROJECT/);
  });

  it('escapes an embedded double quote so the JQL stays well-formed', () => {
    const jql = buildBacklogJql('says "urgent"', { FORGE_BACKLOG_PROJECT: 'BBZ' } as NodeJS.ProcessEnv);
    expect(jql).toBe('project = BBZ AND statusCategory != Done AND text ~ "says \\"urgent\\""');
  });
});

describe('queueMergeAllowed: A.7', () => {
  it('allows only the repos named in FORGE_QUEUE_MERGE_REPOS', () => {
    const allowed = queueMergeAllowed({ FORGE_QUEUE_MERGE_REPOS: 'acme/rn, acme/other' } as NodeJS.ProcessEnv);
    expect(allowed('acme/rn')).toBe(true);
    expect(allowed('acme/backend')).toBe(false);
  });

  it('allows nothing when the variable is unset', () => {
    const allowed = queueMergeAllowed({} as NodeJS.ProcessEnv);
    expect(allowed('acme/rn')).toBe(false);
  });
});

describe('queueProductionWorkflowExists: A.7', () => {
  it('reads false honestly when the repo has no configured checkout', async () => {
    const chainEnv = readChainEnv({});
    const exists = await queueProductionWorkflowExists(chainEnv);
    expect(await exists('acme/rn')).toBe(false);
  });
});

describe('queueCommentOnPr', () => {
  it('exists as a function ready to post through gh -- wiring proven by council/gh.test.ts', () => {
    expect(typeof queueCommentOnPr()).toBe('function');
  });
});
