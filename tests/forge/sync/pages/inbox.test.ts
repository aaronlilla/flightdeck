import { describe, expect, test } from 'vitest';

import { syncInbox } from '../../../../src/forge/sync/pages/inbox.js';

describe('syncInbox', () => {
  test('three issues, one resolved: resolved:1, Sentry sentence present and strictly after the counts sentence', async () => {
    const issues = [{ key: 'BBZ-1' }, { key: 'BBZ-2' }, { key: 'BBZ-3' }];
    const deps = {
      fetch: async () => issues as never,
      classify: () => ({ open: 2, resolved: 1, dropped: 0 }),
    };

    const result = await syncInbox(deps);

    expect(result.counts).toEqual({ open: 2, resolved: 1, dropped: 0 });
    const message = result.message ?? '';
    const sentryIndex = message.indexOf('Sentry: no client (R-13)');
    const countsIndex = message.indexOf('2 open');
    expect(sentryIndex).toBeGreaterThan(-1);
    expect(countsIndex).toBeGreaterThan(-1);
    expect(sentryIndex).toBeGreaterThan(countsIndex);
  });

  test('a fetch throw returns a message with the error and no counts', async () => {
    const deps = {
      fetch: async () => {
        throw new Error('jira unreachable');
      },
      classify: () => ({ open: 0, resolved: 0, dropped: 0 }),
    };

    const result = await syncInbox(deps);

    expect(result.counts).toEqual({});
    expect(result.message).toContain('jira unreachable');
  });
});
