import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConductorAgent } from '../../../src/forge/console/agent.js';
import { ConsoleWrites } from '../../../src/forge/console/command.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { Registry } from '../../../src/forge/registry.js';
import { scriptedQuery } from './agent-fake.js';

/**
 * Aaron, 2026-09-12: "the account i have linked right now hit its weekly limit and it's
 * not moving to the next account that i have linked when i try to answer questions."
 *
 * The rail opened its model session once and reused it forever, so whichever login it
 * picked on its first turn was the login it kept asking. Connecting a fresh account had
 * no effect, and the spent one went on being asked. Measured on the live console: a
 * second Claude account was connected at 19:32:05 and the rail still answered "You've
 * hit your weekly limit" at 19:32:31 and again at 19:32:37.
 *
 * Every turn now asks which login it should be on, and a session that is open on a
 * different one is closed so the next turn starts where the work can happen. The two
 * tests below are the pair: it must move when the answer moves, and it must not restart
 * a healthy session when the answer has not.
 */

const WEEK = 7 * 24 * 60 * 60 * 1000;

let dir: string;
let accountsPath: string;
let accountUsagePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'failover-'));
  mkdirSync(join(dir, 'accounts'), { recursive: true });
  accountsPath = join(dir, 'accounts', 'accounts.json');
  accountUsagePath = join(dir, 'accounts', 'usage.json');
  new Journal(join(dir, 'fleet.jsonl')).close();
  writeFileSync(accountsPath, JSON.stringify({
    accounts: [
      { id: 'spent', provider: 'claude', email: 'first@example.com', label: 'first@example.com', configDir: join(dir, 'config-spent'), connectedAt: 1 },
      { id: 'fresh', provider: 'claude', email: 'second@example.com', label: 'second@example.com', configDir: join(dir, 'config-fresh'), connectedAt: 2 },
    ],
  }), 'utf8');
  // Nothing is limited to begin with, and the first-connected account wins on rank.
  writeFileSync(accountUsagePath, JSON.stringify({}), 'utf8');
});

/** Marks `id` as out of weekly headroom from now, which is what a 429 records. */
function spend(id: string, now: number): void {
  writeFileSync(accountUsagePath, JSON.stringify({
    [id]: { windows: { week: { limitedUntil: now + WEEK, seenAt: now } } },
  }), 'utf8');
}

function agentOn(queryFn: ReturnType<typeof scriptedQuery>['fn'], now: () => number): ConductorAgent {
  const journalPath = join(dir, 'fleet.jsonl');
  const registry = new Registry(join(dir, 'registry'));
  const inbox = new Inbox(join(dir, 'inbox'));
  return new ConductorAgent({
    writes: new ConsoleWrites({
      journalPath, registry, inbox,
      actuator: undefined as never, authorized: () => true, forgeHomeDir: dir,
    }),
    reads: {
      lanesResponse: () => ({ at: now(), lanes: [], tokensToday: 0, tokensPerMin: 0, links: { jiraSite: null, defaultRepo: null } }),
      runThread: () => ({ messages: [] }),
      runStory: async () => ({ id: 'x', title: null, kind: 'manual' as const, ticket: null, brief: null, entries: [] }),
      runSummaryResponse: async () => ({ what: [], status: 'x', next: 'x', audit: null, readiness: null }),
      runRecheckResponse: async () => ({ what: [], status: 'x', next: 'x', audit: null, readiness: null }),
    },
    queue: {
      list: () => ({ items: [], paused: false, maxInFlight: 2 }),
      addItems: async () => ({ ok: true as const, items: [] }),
      remove: () => ({ ok: true, jid: null, message: 'removed', undoable: false }),
      retry: () => ({ ok: true, jid: null, message: 'retried', undoable: false }),
    },
    amend: { registry, journalPath, publish: () => {} },
    inbox, journalPath, publish: () => {},
    queryFn, now,
    accountsPath, accountUsagePath,
    existsConfigDir: () => true,
  });
}

describe('which login a rail turn runs on', () => {
  let agent: ConductorAgent | undefined;
  afterEach(async () => { await agent?.stop(); agent = undefined; });

  it('starts a fresh session once the login it was on runs out', async () => {
    const now = Date.now();
    const fake = scriptedQuery([{ reply: 'first' }, { reply: 'second' }]);
    agent = agentOn(fake.fn, () => now);

    await agent.handle('status');
    expect((fake.calls[0]!.options.env as NodeJS.ProcessEnv)['CLAUDE_CONFIG_DIR'])
      .toBe(join(dir, 'config-spent'));

    spend('spent', now);
    await agent.handle('status');

    expect(fake.calls.length, 'the second turn stayed on the spent login').toBe(2);
    expect((fake.calls[1]!.options.env as NodeJS.ProcessEnv)['CLAUDE_CONFIG_DIR'])
      .toBe(join(dir, 'config-fresh'));
  });

  it('keeps the one session while the login has not moved', async () => {
    const now = Date.now();
    const fake = scriptedQuery([{ reply: 'first' }, { reply: 'second' }]);
    agent = agentOn(fake.fn, () => now);

    await agent.handle('status');
    await agent.handle('status');

    expect(fake.calls.length, 'it threw away a healthy session for no reason').toBe(1);
  });
});
