import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConductorAgent } from '../../../src/forge/console/agent.js';
import { ConsoleWrites } from '../../../src/forge/console/command.js';
import { Inbox } from '../../../src/forge/inbox.js';
import { Journal } from '../../../src/forge/journal.js';
import { Registry } from '../../../src/forge/registry.js';
import type { Message } from '../../../src/shared/console-model.js';
import { scriptedQuery } from './agent-fake.js';

/**
 * Aaron, 2026-09-14: every account was spent, he linked a fresh one, typed "try again",
 * and the Conductor answered "this looks like the start of our conversation". The
 * console had restarted two minutes earlier, and the conversation lived only in the
 * process. Switching accounts would have lost it too: the old session was kept for a
 * resume that cannot find its transcript under the new account's directory.
 *
 * A session with nothing to resume now opens carrying the rail so far, read from the
 * thread file that survives both.
 */

let dir: string;
let accountsPath: string;
let accountUsagePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'carry-'));
  mkdirSync(join(dir, 'accounts'), { recursive: true });
  accountsPath = join(dir, 'accounts', 'accounts.json');
  accountUsagePath = join(dir, 'accounts', 'usage.json');
  new Journal(join(dir, 'fleet.jsonl')).close();
  writeFileSync(accountsPath, JSON.stringify({
    accounts: [
      { id: 'spent', provider: 'claude', email: 'a@example.com', label: 'a@example.com', configDir: join(dir, 'config-spent'), connectedAt: 1 },
      { id: 'fresh', provider: 'claude', email: 'b@example.com', label: 'b@example.com', configDir: join(dir, 'config-fresh'), connectedAt: 2 },
    ],
  }), 'utf8');
  writeFileSync(accountUsagePath, JSON.stringify({}), 'utf8');
});

function row(type: Message['type'], text: string, extra: Partial<Message> = {}): Message {
  return { k: text, type, text, ts: 1, source: type === 'operator' ? 'operator' : 'conductor', ...extra } as Message;
}

function agentOn(queryFn: ReturnType<typeof scriptedQuery>['fn'], thread: () => Message[], now: () => number): ConductorAgent {
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
    appendThread: () => {},
    readThread: thread,
  });
}

describe('a fresh Conductor session knows what was going on', () => {
  let agent: ConductorAgent | undefined;
  afterEach(async () => { await agent?.stop(); agent = undefined; });

  it('after a console restart, the first message carries the rail so far', async () => {
    const now = Date.now();
    const fake = scriptedQuery([{ reply: 'retrying BBZ-303' }]);
    const thread = [
      row('reply', 'BBZ-303 has parked with no error after 2 restarts', { path: 'agent' }),
      row('operator', 'restart the parked ones'),
      row('reply', 'The Conductor could not answer (every linked account is spent).', { path: 'grammar' }),
      row('operator', 'try again'),
    ];
    agent = agentOn(fake.fn, () => thread, () => now);

    await agent.handle('try again');

    expect(fake.calls[0]!.options.resume, 'there is no session to resume after a restart').toBeUndefined();
    expect(fake.prompts[0]).toMatch(/<handoff>[\s\S]*conductor: BBZ-303 has parked[\s\S]*operator: restart the parked ones[\s\S]*grammar: The Conductor could not answer[\s\S]*<\/handoff>/);
    expect(fake.prompts[0], 'the message being answered is not repeated inside its own handoff').not.toMatch(/operator: try again/);
  });

  it('on an account switch, the new session does not resume the old id and carries the rail instead', async () => {
    const now = Date.now();
    const fake = scriptedQuery([{ reply: 'first' }, { reply: 'second' }]);
    const thread: Message[] = [];
    agent = agentOn(fake.fn, () => thread, () => now);

    await agent.handle('status');
    thread.push(row('operator', 'status'), row('reply', 'first', { path: 'agent' }));
    writeFileSync(accountUsagePath, JSON.stringify({
      spent: { windows: { week: { limitedUntil: now + 7 * 24 * 60 * 60 * 1000, seenAt: now } } },
    }), 'utf8');
    await agent.handle('try again');

    expect(fake.calls.length).toBe(2);
    expect(fake.calls[1]!.options.resume, 'resumed a transcript that lives under the other account').toBeUndefined();
    expect(fake.prompts[1]).toMatch(/<handoff>[\s\S]*operator: status[\s\S]*conductor: first[\s\S]*<\/handoff>/);
  });

  it('a session that is still open gets no handoff', async () => {
    const now = Date.now();
    const fake = scriptedQuery([{ reply: 'first' }, { reply: 'second' }]);
    agent = agentOn(fake.fn, () => [row('operator', 'earlier')], () => now);

    await agent.handle('status');
    await agent.handle('status');

    expect(fake.prompts[1]).not.toMatch(/<handoff>/);
  });
});
