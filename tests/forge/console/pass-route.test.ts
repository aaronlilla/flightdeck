/**
 * Pass to… through the console's own command route (R-76, spec §10: accept first, work
 * second).
 *
 * The point of this file is the clock: Slack is injected as a `fetch` that takes two
 * seconds, and the route still has to answer in well under a fifth of one, with
 * `action.accepted` already on the journal before the post goes anywhere.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConsoleWrites, parseIntent } from '../../../src/forge/console/command.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Registry } from '../../../src/forge/registry.js';
import type { Actuator } from '../../../src/forge/contracts.js';
import { MAX_OPEN_PASSES, type SlackConfig } from '../../../src/forge/intake/slack.js';

const SLOW_FETCH_MS = 2_000;
const ROUTE_BUDGET_MS = 200;

const noopActuator = {
  kill: async () => ({ ok: true }),
  pause: async () => ({ ok: true }),
  resume: async () => ({ ok: true }),
} as unknown as Actuator;

let dir: string;
let journalPath: string;
let inbox: Inbox;
let writes: ConsoleWrites;
let posted: { askKey: string; name: string }[];
let postStarted: number;
let previousHome: string | undefined;
/** Set by a specimen to make the injected poster refuse instead of posting. */
let refusePost: string | null;

function slackConfig(): SlackConfig {
  return { token: 'test-token', channel: 'C1', users: { joe: 'U0JOE' } };
}

function journalEvents(): string[] {
  if (!journalPath) return [];
  return readFileSync(journalPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-pass-'));
  previousHome = process.env['FORGE_HOME'];
  process.env['FORGE_HOME'] = dir;
  journalPath = join(dir, 'fleet.jsonl');
  inbox = new Inbox(join(dir, 'inbox'));
  posted = [];
  postStarted = 0;
  refusePost = null;
  writes = new ConsoleWrites({
    journalPath,
    registry: new Registry(join(dir, 'registry')),
    inbox,
    actuator: noopActuator,
    authorized: () => true,
    ledgerPath: join(dir, 'actions.jsonl'),
    capsOverridesPath: join(dir, 'caps.json'),
    rulesConfigPath: join(dir, 'rules.json'),
    integrationsConfigPath: join(dir, 'integrations.json'),
    slackConfig: () => slackConfig(),
    postQuestion: async (askKey, name, deps) => {
      if (refusePost) {
        deps.inbox.clearPass(askKey);
        return { ok: false, reason: refusePost };
      }
      postStarted = Date.now();
      posted.push({ askKey, name });
      await new Promise((resolve) => setTimeout(resolve, SLOW_FETCH_MS));
      return { ok: true, ts: '1757600000.000100' };
    },
  });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['FORGE_HOME'];
  else process.env['FORGE_HOME'] = previousHome;
});

function raiseAsk(): string {
  return inbox.raise({
    run: 'item:Q-1', question: 'Do we hide the row or show a zero?',
    options: ['hide', 'zero'], kind: 'question', ticket: 'BBZ-277',
  }).key;
}

describe('the pass command', () => {
  it('parses "pass <askKey> <name>" and "pass <askKey> to <name>"', () => {
    expect(parseIntent('pass ab12cd34 Joe')).toEqual({ kind: 'pass', askKey: 'ab12cd34', name: 'Joe' });
    expect(parseIntent('pass ab12cd34 to Joe')).toEqual({ kind: 'pass', askKey: 'ab12cd34', name: 'Joe' });
  });

  it('answers in well under 200 ms with a 2 s post, and journals action.accepted first', async () => {
    const key = raiseAsk();

    const started = Date.now();
    const cards = await writes.runGrammar(`pass ${key} Joe`, 'rail');
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(ROUTE_BUDGET_MS);
    expect(cards[0]!.text).toContain('Passed to Joe');

    // The post was started, and the response did not wait for it.
    expect(posted).toEqual([{ askKey: key, name: 'Joe' }]);
    expect(postStarted).toBeGreaterThan(0);

    const events = journalEvents();
    expect(events).toContain('action.accepted');
    expect(events.indexOf('action.accepted')).toBeLessThan(events.length);

    // The fields are set the moment the operator clicks, not when Slack answers.
    const entry = inbox.entry(key)!;
    expect(entry.passedTo).toBe('Joe');
    expect(typeof entry.passedAt).toBe('number');
    expect(entry.answeredBy).toBeNull();
  }, 10_000);

  // Found by code review, 2026-09-11. The route set `passedTo` before calling the poster,
  // and the poster skipped its own cap whenever `passedTo` was already set -- so the cap
  // could never fire on the real path, while the poster's own specimen (which calls it on
  // an un-passed ask) stayed green. The cap has to be checked where the click is.
  it('refuses an eleventh open pass at the route, without starting a post', async () => {
    for (let i = 0; i < MAX_OPEN_PASSES; i += 1) {
      const open = inbox.raise({ run: `item:Q-${i}`, question: `question ${i}`, kind: 'question' });
      inbox.pass(open.key, 'Joe', 1, `17576.${i}`);
    }
    const key = raiseAsk();

    const cards = await writes.runGrammar(`pass ${key} Joe`, 'rail');

    expect(cards[0]!.text).toContain(String(MAX_OPEN_PASSES));
    expect(posted).toHaveLength(0);
    expect(inbox.entry(key)!.passedTo).toBeUndefined();
  });

  // Found by code review, 2026-09-11. A guard denial returns before the poster's own
  // rollback, and the route had already written `passedTo` -- so a question the guards
  // refused to send stayed marked as passed forever, counted against the cap and never
  // polled for a reply.
  it('rolls the fields back when the post refuses, so a denied pass is not left passed', async () => {
    const key = raiseAsk();
    refusePost = 'I can\'t pass this on: banned word(s) in prose: just';

    await writes.runGrammar(`pass ${key} Joe`, 'rail');

    const entry = inbox.entry(key)!;
    expect(entry.passedTo).toBeNull();
    expect(entry.passedThread).toBeNull();
  });

  it('refuses an unknown name without starting a post', async () => {
    const key = raiseAsk();
    const cards = await writes.runGrammar(`pass ${key} Mallory`, 'rail');
    expect(cards[0]!.text).toContain('Mallory');
    expect(posted).toHaveLength(0);
    expect(inbox.entry(key)!.passedTo).toBeUndefined();
  });

  it('refuses a question it has never heard of without starting a post', async () => {
    const cards = await writes.runGrammar('pass deadbeef Joe', 'rail');
    expect(cards[0]!.text).toContain('deadbeef');
    expect(posted).toHaveLength(0);
  });
});
