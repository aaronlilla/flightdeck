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

  // Updated 2026-09-12 (item 13): this asserted "No visual check needed", which is the
  // sentence the item exists to remove -- nobody had looked, so nobody could say that.
  // With no test plan the comment still invents no steps; it says what is unverified.
  it('invents no steps when the brief gave none, and says what is unverified', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'fixes a null check.', testPlan: [],
    });
    expect(body).not.toContain('Quick visual check:');
    expect(body).toMatch(/nothing here was looked at on a screen/i);
  });
});

// Item 13, 2026-09-12: the comment posted at 16:01 on 2026-09-11 told QA "No visual
// check needed here -- this one is covered by the suite." No agent had looked at a
// screen, and the change installed a touch handler at the app root, so every screen
// was affected. The text is generated, so it keeps saying it.
describe('the handoff never claims a visual check is unnecessary', () => {
  it('names the screens a UI diff touches and says nothing was looked at', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-169', prUrl: 'https://github.com/acme/app/pull/12',
      what: 'the player card drop-down closes on an outside tap.', testPlan: [],
      changedFiles: [
        'src/features/wallet/screens/WalletScreen.tsx',
        'src/features/rewards/screens/RewardsHomeScreen.tsx',
        'src/app/store.ts',
      ],
    });
    expect(body).not.toContain('No visual check needed');
    expect(body).toContain('WalletScreen');
    expect(body).toContain('RewardsHomeScreen');
    expect(body).toMatch(/nothing here was looked at on a screen/i);
  });

  it('says a root-level touch handler reaches every screen', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-169', prUrl: 'https://github.com/acme/app/pull/12',
      what: 'captures taps at the app root.', testPlan: [],
      changedFiles: ['src/app/AppRoot.tsx'],
    });
    expect(body).toMatch(/every screen/i);
  });

  it('gives the honest short form for a diff with no screens in it', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'fixes a null check.',
      testPlan: [], changedFiles: ['src/forge/intake/queue.ts'],
    });
    expect(body).not.toContain('No visual check needed');
    expect(body).toMatch(/no screen changes in this diff/i);
  });

  it('still carries a test plan when the brief supplied one', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-2', prUrl: 'https://github.com/acme/app/pull/2', what: 'timestamps in UTC.',
      testPlan: ['open transaction history', 'check the timestamps'],
      changedFiles: ['src/features/wallet/screens/HistoryScreen.tsx'],
    });
    expect(body).toContain('open transaction history');
    expect(body).toMatch(/nothing here was looked at on a screen/i);
  });

  // Edge: the caller knows nothing about the diff. Saying a check is unnecessary is
  // still the one thing the comment may never do.
  it('never claims a check is unnecessary when the changed files are unknown', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-3', prUrl: 'https://github.com/acme/app/pull/3', what: 'something.', testPlan: [],
    });
    expect(body).not.toContain('No visual check needed');
    expect(body).toMatch(/nothing here was looked at on a screen/i);
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
