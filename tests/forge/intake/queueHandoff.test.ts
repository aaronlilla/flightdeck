/**
 * A.3: the queue's own Jira write-back at review, against a fake JiraWriteClient --
 * no specimen here touches the network.
 */
import { describe, expect, it } from 'vitest';

import { buildQueueHandoffComment, runQueueHandoff, type QueueHandoffEvent } from '../../../src/forge/intake/queueHandoff.js';
import type { JiraCallResult, JiraWriteClient } from '../../../src/forge/intake/jira.js';
import { readabilityVerdict } from '../../../src/forge/intake/readability.js';

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
    expect(body).toMatch(/nobody has looked at this on a screen/i);
  });
});

// Item 13, 2026-09-12: the comment posted at 16:01 on 2026-09-11 told QA "No visual
// check needed here -- this one is covered by the suite." No agent had looked at a
// screen, and the change installed a touch handler at the app root, so every screen
// was affected. The first fix replaced it with "there is nothing on screen to
// compare", which a review showed was the same unearned claim in new words.
describe('the handoff makes no claim about the rendered result', () => {
  const NOTHING_LOOKED = /nobody has looked at this on a screen/i;

  it('names the files that render and says nobody looked', () => {
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
    expect(body).toMatch(NOTHING_LOOKED);
  });

  it('says a root-level change reaches every screen', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-169', prUrl: 'https://github.com/acme/app/pull/12',
      what: 'captures taps at the app root.', testPlan: [],
      changedFiles: ['src/app/AppRoot.tsx'],
    });
    expect(body).toMatch(/every screen/i);
  });

  // The review's own specimen: a colour token and a navigator repaint every screen and
  // look like neither. Saying "nothing to compare" here is the original defect.
  it('claims nothing about a diff whose files do not look like views', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-1', prUrl: 'https://github.com/acme/app/pull/1', what: 'new palette.',
      testPlan: [], changedFiles: ['src/theme/colors.ts'],
    });
    expect(body).not.toMatch(/nothing (on screen )?to compare/i);
    expect(body).not.toMatch(/no screen changes/i);
    expect(body).toMatch(NOTHING_LOOKED);
  });

  it('keeps the unverified sentence even when the brief supplied a test plan', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-2', prUrl: 'https://github.com/acme/app/pull/2', what: 'timestamps in UTC.',
      testPlan: ['open transaction history', 'check the timestamps'],
      changedFiles: ['src/forge/queue.ts'],
    });
    expect(body).toContain('open transaction history');
    expect(body).toMatch(NOTHING_LOOKED);
  });

  it('never claims a check is unnecessary when the changed files are unknown', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-3', prUrl: 'https://github.com/acme/app/pull/3', what: 'something.', testPlan: [],
    });
    expect(body).not.toContain('No visual check needed');
    expect(body).toMatch(NOTHING_LOOKED);
  });

  // Edge: slices, barrels, types, tests and snapshots render nothing a person opens,
  // and a list padded with them trains a reader to skim past it.
  it('leaves slices, barrels, tests and snapshots out of the list', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-4', prUrl: 'https://github.com/acme/app/pull/4', what: 'wallet state.',
      testPlan: [],
      changedFiles: [
        'src/features/wallet/walletSlice.ts', 'src/features/wallet/index.ts',
        'src/features/wallet/types.ts', 'src/features/wallet/WalletScreen.test.tsx',
        'src/features/wallet/__snapshots__/WalletScreen.test.tsx.snap',
      ],
    });
    expect(body).not.toContain('walletSlice');
    expect(body).not.toContain('wallet/types');
    expect(body).not.toContain('.test');
  });

  // Edge: two files of the same name under different features are two files.
  it('keeps two same-named components apart', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-5', prUrl: 'https://github.com/acme/app/pull/5', what: 'headers.', testPlan: [],
      changedFiles: [
        'src/features/wallet/components/Header.tsx',
        'src/features/rewards/components/Header.tsx',
      ],
    });
    expect(body).toContain('wallet/Header');
    expect(body).toContain('rewards/Header');
  });

  // Edge: the comment is checked against a prose-word ceiling that DENIES, and a denied
  // comment posts nothing at all -- so the biggest diffs got silence.
  it('caps the list so a large diff still posts a comment', () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/features/f${i}/Thing${i}.tsx`);
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-6', prUrl: 'https://github.com/acme/app/pull/6', what: 'lots.', testPlan: [],
      changedFiles: files,
    });
    expect(body).toMatch(/and at least 22 more/);
    expect(body).not.toContain('Thing29');
  });

  // Found by code review, 2026-09-12: the fix removed one unearned claim and added
  // another a line below it. Nothing in the input carries a test or typecheck result,
  // and an item whose worker was parked reaches this handoff anyway.
  it('claims nothing about the tests, which it has no result for', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-8', prUrl: 'https://github.com/acme/app/pull/8', what: 'x.', testPlan: [],
      changedFiles: ['src/features/wallet/WalletScreen.tsx'],
    });
    expect(body).not.toMatch(/tests pass/i);
    expect(body).not.toMatch(/types are clean/i);
    expect(body).toMatch(/nobody has looked at this on a screen/i);
  });

  // The names are counted by a prose-word ceiling that denies the whole comment, and
  // scanned for banned words. Code in backticks is exempt from both.
  it('wraps every name in backticks so a path cannot deny the comment', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-9', prUrl: 'https://github.com/acme/app/pull/9', what: 'x.', testPlan: [],
      changedFiles: ['src/features/camera/Lens.tsx'],
    });
    expect(body).toContain('`camera/Lens`');
  });

  // The real app-wide files in the mobile repo are the navigators, and none of them
  // matched the first pattern.
  it.each([
    'src/navigation/MainStack.tsx',
    'src/navigation/MainTabs.tsx',
    'src/navigation/CustomTabBar.tsx',
    'src/navigation/index.tsx',
  ])('says %s reaches every screen', (file) => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-10', prUrl: 'https://github.com/acme/app/pull/10', what: 'x.', testPlan: [],
      changedFiles: [file],
    });
    expect(body).toMatch(/every screen/i);
  });

  // The file list includes deletions, so the heading may not promise the file exists.
  it('does not claim a listed file renders, since the list includes deletions', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-11', prUrl: 'https://github.com/acme/app/pull/11', what: 'drop the old screen.',
      testPlan: [], changedFiles: ['src/features/legacy/OldWallet.tsx'],
    });
    expect(body).not.toMatch(/files that render/i);
    expect(body).toMatch(/adds, changes or removes/i);
  });

  // Found by code review, 2026-09-12: the closing clause pointed at a list that is
  // only printed when something in the diff renders. Most of what the queue ships is
  // backend or plain TypeScript, which names nothing.
  it('does not refer to a list it did not print', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-12', prUrl: 'https://github.com/acme/app/pull/12', what: 'a null check.',
      testPlan: [], changedFiles: ['src/forge/intake/queue.ts'],
    });
    expect(body).not.toMatch(/list above/i);
    expect(body).toMatch(/nobody has looked at this on a screen/i);
  });

  // Found by code review, 2026-09-12: matching a bare Navigation file anywhere, or any
  // directory named navigation, claimed "reaches every screen" for one feature's own
  // nav file -- the same false claim this file removes.
  it.each([
    'src/features/wallet/Navigation.tsx',
    'src/components/ui/navigation/Tabs.tsx',
  ])('does not call %s the app root', (file) => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-13', prUrl: 'https://github.com/acme/app/pull/13', what: 'x.', testPlan: [],
      changedFiles: [file],
    });
    expect(body).not.toMatch(/every screen/i);
  });

  // Found by code review, 2026-09-12: stripping the generic segment could collapse two
  // paths the full path had told apart, so the list printed the same name twice.
  it('keeps two files apart when stripping the generic folder would collide them', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-14', prUrl: 'https://github.com/acme/app/pull/14', what: 'x.', testPlan: [],
      changedFiles: [
        'src/features/wallet/components/Header.tsx',
        'src/features/wallet/screens/Header.tsx',
      ],
    });
    const matches = body.match(/`[^`]*Header`/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(new Set(matches).size).toBe(2);
  });

  // Found by code review, 2026-09-12: a render helper is not a screen.
  it('leaves render helpers under __tests__ and test-utils out', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-15', prUrl: 'https://github.com/acme/app/pull/15', what: 'x.', testPlan: [],
      changedFiles: [
        'src/features/wallet/__tests__/renderWallet.tsx',
        'src/test-utils/renderWithStore.tsx',
      ],
    });
    expect(body).not.toContain('renderWallet');
    expect(body).not.toContain('renderWithStore');
  });

  // Found by code review, 2026-09-12, proven by running the pattern: the root check
  // ran over the raw file list, and `[^/]+` ate `MainStack.test`, so a pull request
  // repairing one navigation test told QA the change reaches every screen.
  it.each([
    'src/navigation/MainStack.test.tsx',
    'src/navigation/RootNavigator.stories.tsx',
    'src/navigation/MainTabs.spec.tsx',
  ])('does not call %s the app root', (file) => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-16', prUrl: 'https://github.com/acme/app/pull/16', what: 'x.', testPlan: [],
      changedFiles: [file],
    });
    expect(body).not.toMatch(/every screen/i);
  });

  // Found by code review, 2026-09-12: widening runs out of segments on a shallow path,
  // and the colliding name was then pushed unchanged.
  it.each([
    [['src/components/Header.tsx', 'src/Header.tsx']],
    [['app/Home.tsx', 'ui/Home.tsx']],
  ])('keeps shallow same-named paths apart: %s', (files) => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-17', prUrl: 'https://github.com/acme/app/pull/17', what: 'x.', testPlan: [],
      changedFiles: files,
    });
    const matches = body.match(/`[^`]+`/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(new Set(matches).size).toBe(2);
  });

  // Found by code review, 2026-09-12, twice. First: the long sentence plus a supplied
  // plan came to 98 prose words against a ceiling of 80, and a comment over the
  // ceiling is DENIED and posts nothing at all. Then: the test re-implemented the word
  // count instead of importing the one that decides, so it could go green while the
  // write was refused. It asks the real check now.
  it('stays inside the real ceiling with a plan and a full list', () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/features/f${i}/Thing${i}.tsx`);
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-18', prUrl: 'https://github.com/acme/app/pull/18',
      what: 'the drop-down closes on an outside tap.',
      testPlan: ['open the player card', 'tap outside it', 'check the row underneath',
        'reopen it', 'tap the same row again'],
      changedFiles: ['src/navigation/MainStack.tsx', ...files],
    });
    expect(readabilityVerdict('jira-comment', null, '', body, undefined, '2026-09-12').verdict)
      .not.toBe('DENY');
  });

  // Found by code review, 2026-09-12, against the real mobile repo: matching every
  // file directly under the navigation directory said "reaches every screen" of
  // `AuthStack` and `RegistrationStack`, which wrap one flow, not the app.
  it.each(['src/navigation/AuthStack.tsx', 'src/navigation/RegistrationStack.tsx'])(
    'does not call %s the app root', (file) => {
      const body = buildQueueHandoffComment({
        ticket: 'BBZ-19', prUrl: 'https://github.com/acme/app/pull/19', what: 'x.', testPlan: [],
        changedFiles: [file],
      });
      expect(body).not.toMatch(/every screen/i);
    },
  );

  // Found by code review, 2026-09-12: the fallback kept the extension, so one entry in
  // a comma list read in a different format from the rest, and the widened name
  // claimed a path that does not exist.
  it('keeps every entry in one format when a shallow collision falls back', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-20', prUrl: 'https://github.com/acme/app/pull/20', what: 'x.', testPlan: [],
      changedFiles: ['Header.tsx', 'src/Header.tsx'],
    });
    expect(body).not.toMatch(/\.tsx/);
    const matches = body.match(/`[^`]+`/g) ?? [];
    expect(new Set(matches).size).toBe(2);
  });

  // Found by code review, 2026-09-12: the mobile repo keeps a render mock at
  // jest/svgMock.tsx, which is not a screen.
  it('leaves a render mock under jest out of the list', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-21', prUrl: 'https://github.com/acme/app/pull/21', what: 'x.', testPlan: [],
      changedFiles: ['jest/svgMock.tsx'],
    });
    expect(body).not.toContain('svgMock');
  });

  // Edge: an empty list is not proof of anything -- the file list pages at 100 and can
  // come back empty when the JSON lacks the field.
  it('claims nothing from an empty file list', () => {
    const body = buildQueueHandoffComment({
      ticket: 'BBZ-7', prUrl: 'https://github.com/acme/app/pull/7', what: 'x.', testPlan: [],
      changedFiles: [],
    });
    expect(body).toMatch(NOTHING_LOOKED);
    expect(body).not.toMatch(/nothing (on screen )?to compare/i);
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
