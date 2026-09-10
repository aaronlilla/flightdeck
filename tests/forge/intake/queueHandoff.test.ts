/**
 * A.3: the queue's own Jira write-back at review, against a fake JiraWriteClient --
 * no specimen here touches the network.
 */
import { describe, expect, it } from 'vitest';

import { buildQueueHandoffComment, runQueueHandoff, type QueueHandoffEvent } from '../../../src/forge/intake/queueHandoff.js';
import type { JiraCallResult, JiraWriteClient } from '../../../src/forge/intake/jira.js';

function fakeClient(overrides: Partial<JiraWriteClient> = {}): JiraWriteClient {
  return {
    async comment() { return { ok: true }; },
    async assign() { return { ok: true }; },
    async transition() { return { ok: true }; },
    async link() { return { ok: true }; },
    ...overrides,
  };
}

describe('buildQueueHandoffComment', () => {
  it('carries the PR link, what changed, and the visual test plan steps', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-226', prUrl: 'https://github.com/acme/app/pull/12',
      what: 'transaction history renders in UTC now.', testPlan: ['open transaction history', 'check the timestamps'],
    });
    expect(body).toContain('https://github.com/acme/app/pull/12');
    expect(body).toContain('renders in UTC');
    expect(body).toContain('open transaction history');
  });

  it('says plainly when there is no visual check, never invents steps', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'fixes a null check.', testPlan: [],
    });
    expect(body).toContain('No visual check needed');
  });
});

describe('runQueueHandoff', () => {
  it('runs comment, assign, transition and link, always in that order', async () => {
    const calls: string[] = [];
    const client = fakeClient({
      async comment(key) { calls.push(`comment:${key}`); return { ok: true }; },
      async assign(key, id) { calls.push(`assign:${key}:${id}`); return { ok: true }; },
      async transition(key, id) { calls.push(`transition:${key}:${id}`); return { ok: true }; },
      async link(key, url) { calls.push(`link:${key}:${url}`); return { ok: true }; },
    });
    const events: QueueHandoffEvent[] = [];

    await runQueueHandoff(
      client,
      { ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'a fix.', testPlan: [] },
      { qaAccountId: 'acc-1', qaTransitionId: '31' },
      (event) => events.push(event),
    );

    expect(calls).toEqual([
      'comment:BBZ-1', 'assign:BBZ-1:acc-1', 'transition:BBZ-1:31', 'link:BBZ-1:https://github.com/acme/app/pull/1',
    ]);
    expect(events.filter((e) => e.kind === 'jira-link').map((e) => e.event))
      .toEqual(['external.intent', 'external.call', 'external.complete']);
  });

  it('skips the assign and transition writes when their environment variable is unset', async () => {
    const calls: string[] = [];
    const client = fakeClient({
      async comment(key) { calls.push(`comment:${key}`); return { ok: true }; },
      async assign(key) { calls.push(`assign:${key}`); return { ok: true }; },
      async transition(key) { calls.push(`transition:${key}`); return { ok: true }; },
    });

    await runQueueHandoff(
      client, { ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'a fix.', testPlan: [] }, {}, () => {},
    );

    expect(calls).not.toContain('assign:BBZ-1');
    expect(calls).not.toContain('transition:BBZ-1');
  });

  it('a failing comment call never stops the assign, transition or link writes', async () => {
    const calls: string[] = [];
    const client = fakeClient({
      async comment() { return { ok: false, status: 500, body: 'server error' }; },
      async assign(key) { calls.push(`assign:${key}`); return { ok: true }; },
      async transition(key) { calls.push(`transition:${key}`); return { ok: true }; },
      async link(key) { calls.push(`link:${key}`); return { ok: true }; },
    });

    const lines = await runQueueHandoff(
      client,
      { ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'a fix.', testPlan: [] },
      { qaAccountId: 'acc-1', qaTransitionId: '31' },
      () => {},
    );

    expect(calls).toEqual(['assign:BBZ-1', 'transition:BBZ-1', 'link:BBZ-1']);
    expect(lines[0]).toContain('unknown');
  });

  it('refuses to post a comment the voice guard would deny, without stopping the rest of the handoff', async () => {
    const calls: string[] = [];
    const client = fakeClient({
      async comment(key) { calls.push(`comment:${key}`); return { ok: true }; },
      async link(key) { calls.push(`link:${key}`); return { ok: true }; },
    });
    const events: QueueHandoffEvent[] = [];

    // A `what` line that reads as third-person narration about Aaron -- the exact shape
    // `voiceGuard.ts`'s own proven detector exists to catch.
    await runQueueHandoff(
      client,
      { ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'Aaron reported the fix is done.', testPlan: [] },
      {}, (event) => events.push(event),
    );

    expect(calls).not.toContain('comment:BBZ-1');
    expect(calls).toContain('link:BBZ-1');
    expect(events.some((e) => e.event === 'voice.refused')).toBe(true);
  });

  it('refuses to post a comment over the readability ceiling, without stopping the rest of the handoff', async () => {
    const calls: string[] = [];
    const client = fakeClient({
      async comment(key) { calls.push(`comment:${key}`); return { ok: true }; },
      async link(key) { calls.push(`link:${key}`); return { ok: true }; },
    });
    const events: QueueHandoffEvent[] = [];

    const longTestPlan = Array.from({ length: 20 }, (_v, i) => `step number ${i} in the visual check plan`);
    await runQueueHandoff(
      client,
      { ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'fixes a null check.', testPlan: longTestPlan },
      {}, (event) => events.push(event),
    );

    expect(calls).not.toContain('comment:BBZ-1');
    expect(calls).toContain('link:BBZ-1');
    expect(events.some((e) => e.event === 'readability.refused')).toBe(true);
  });
});
