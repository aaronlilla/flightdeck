/**
 * J3: the three handoff writes `forge gate --merge` makes once a merge lands and the
 * PR names a ticket. Every client here is a fake -- no specimen touches the network.
 */
import { describe, expect, it } from 'vitest';

import { buildHandoffComment, runJiraHandoff, type JiraHandoffEvent } from '../../../src/forge/intake/jiraHandoff.js';
import type { JiraCallResult, JiraWriteClient } from '../../../src/forge/intake/jira.js';
import type { HaipingHandoff } from '../../../src/forge/contracts.js';

const HAIPING: HaipingHandoff = {
  ticket: 'BBZ-1', pr: 'acme/widgets#105', deployKind: 'ota',
  perPlatform: { android: 'fingerprint-a', ios: 'fingerprint-i' },
  steps: ['open the app', 'check the login screen'],
  notVisuallyVerified: ['dark mode'],
};

function fakeClient(overrides: Partial<JiraWriteClient> = {}): JiraWriteClient {
  return {
    async comment() { return { ok: true }; },
    async assign() { return { ok: true }; },
    async transition() { return { ok: true }; },
    ...overrides,
  };
}

describe('buildHandoffComment', () => {
  it('carries the deploy kind, both platform lines, the steps and the not-visually-verified line', () => {
    const body = buildHandoffComment(HAIPING, 'https://github.com/acme/widgets/pull/105');
    expect(body).toContain('https://github.com/acme/widgets/pull/105');
    expect(body).toContain('OTA');
    expect(body).toContain('fingerprint-a');
    expect(body).toContain('fingerprint-i');
    expect(body).toContain('open the app');
    expect(body).toContain('dark mode');
    expect(body).not.toContain('**');
    expect(body).not.toMatch(/—|--/);
  });
});

describe('runJiraHandoff — the three writes, in order', () => {
  it('runs comment, assign, transition in that order when both optional env vars are set', async () => {
    const calls: string[] = [];
    const client = fakeClient({
      async comment(key) { calls.push(`comment:${key}`); return { ok: true }; },
      async assign(key, accountId) { calls.push(`assign:${key}:${accountId}`); return { ok: true }; },
      async transition(key, transitionId) { calls.push(`transition:${key}:${transitionId}`); return { ok: true }; },
    });
    const events: JiraHandoffEvent[] = [];

    await runJiraHandoff(client, HAIPING, 'head-1', 'https://github.com/acme/widgets/pull/105', {
      qaAccountId: 'acc-1', qaTransitionId: '31',
    }, (event) => events.push(event));

    expect(calls).toEqual(['comment:BBZ-1', 'assign:BBZ-1:acc-1', 'transition:BBZ-1:31']);
    expect(events.filter((e) => e.kind === 'jira-comment').map((e) => e.event))
      .toEqual(['external.intent', 'external.call', 'external.complete']);
    expect(events.filter((e) => e.kind === 'jira-assign').map((e) => e.event))
      .toEqual(['external.intent', 'external.call', 'external.complete']);
    expect(events.filter((e) => e.kind === 'jira-transition').map((e) => e.event))
      .toEqual(['external.intent', 'external.call', 'external.complete']);
  });

  it('skips assign and transition when their env vars are absent', async () => {
    const calls: string[] = [];
    const client = fakeClient({ async assign() { calls.push('assign'); return { ok: true }; } });
    const events: JiraHandoffEvent[] = [];
    await runJiraHandoff(client, HAIPING, 'head-1', 'https://github.com/acme/widgets/pull/105', {}, (e) => events.push(e));
    expect(calls).toEqual([]);
    expect(events.some((e) => e.kind === 'jira-assign')).toBe(false);
    expect(events.some((e) => e.kind === 'jira-transition')).toBe(false);
  });

  it('a failing comment call still runs the assignment and the transition, and reports unknown with the status and body', async () => {
    const failing: JiraCallResult = { ok: false, status: 500, body: 'internal server error, retry later'.repeat(20) };
    const calls: string[] = [];
    const client = fakeClient({
      async comment() { return failing; },
      async assign() { calls.push('assign'); return { ok: true }; },
    });
    const events: JiraHandoffEvent[] = [];

    await runJiraHandoff(client, HAIPING, 'head-1', 'https://github.com/acme/widgets/pull/105', {
      qaAccountId: 'acc-1',
    }, (e) => events.push(e));

    expect(calls).toEqual(['assign']);
    const commentEvents = events.filter((e) => e.kind === 'jira-comment');
    expect(commentEvents.at(-1)?.event).toBe('external.unknown');
    expect(commentEvents.at(-1)?.status).toBe(500);
    expect(commentEvents.at(-1)?.body?.length).toBeLessThanOrEqual(300);
    const assignEvents = events.filter((e) => e.kind === 'jira-assign');
    expect(assignEvents.at(-1)?.event).toBe('external.complete');
  });
});
