/**
 * Seeding a new login directory, and bringing a terminal back when its login runs dry.
 *
 * Both are ways to lose something quietly. Seeding writes into a directory, so the case
 * that matters is the one where it must NOT: a directory already holding a live login's
 * transcripts, which turning into a junction would strand. The switch relaunches a
 * terminal, so the case that matters is the one where it must not relaunch: a marker old
 * enough to be about a limit that has already lifted.
 *
 * Every directory here is a real temporary directory and every junction a real one, so a
 * seed that only pretended to link would fail the resolution assertions.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { checkAddCandidate, seedConfigDir, SEEDED_COPIES, SEEDED_LINKS, validateAccounts, type AccountRecord } from '../../src/forge/accounts.js';
import {
  clearSwitchMarker, markerPath, readSwitchMarker, sessionsFromConfigDir, switchLimitedAccount, switchMessage,
} from '../../src/forge/accounts-switch.js';
import type { AccountUsage } from '../../src/forge/accounts-usage.js';
import { ConsoleWrites } from '../../src/forge/console/command.js';
import { Inbox } from '../../src/forge/inbox.js';
import { Registry } from '../../src/forge/registry.js';
import type { Actuator, DecisionId, RunId } from '../../src/forge/contracts.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-fabric-'));
  process.env['FORGE_HOME'] = dir;
});

function operatorTree(): string {
  const operator = join(dir, 'operator');
  for (const name of SEEDED_LINKS) mkdirSync(join(operator, name), { recursive: true });
  writeFileSync(join(operator, 'projects', 'a-transcript.jsonl'), '{}\n', 'utf8');
  writeFileSync(join(operator, 'settings.json'), '{"theme":"dark"}', 'utf8');
  writeFileSync(join(operator, 'CLAUDE.md'), '# the operator\n', 'utf8');
  return operator;
}

describe('seeding a login directory', () => {
  it('links the four shared trees and copies the two shared files', () => {
    const operator = operatorTree();
    const fresh = join(dir, 'fresh');
    const result = seedConfigDir(fresh, operator);
    expect(result.ok).toBe(true);

    for (const name of SEEDED_LINKS) {
      const link = join(fresh, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      // Resolved, not just present: a link pointing somewhere else would pass a
      // an existence check and fail this one.
      expect(realpathSync(link)).toBe(realpathSync(join(operator, name)));
    }
    // The shared transcript tree is the whole reason a resume works across logins.
    expect(existsSync(join(fresh, 'projects', 'a-transcript.jsonl'))).toBe(true);
    for (const name of SEEDED_COPIES) {
      expect(readFileSync(join(fresh, name), 'utf8')).toBe(readFileSync(join(operator, name), 'utf8'));
      expect(lstatSync(join(fresh, name)).isSymbolicLink()).toBe(false);
    }
  });

  it('never puts a credentials file in the new directory', () => {
    const operator = operatorTree();
    // Even if the operator's own directory holds one, seeding must not be a way to copy
    // a login. This is the only assertion in this suite about that file, and it is about
    // its absence: nothing here opens or reads one.
    writeFileSync(join(operator, '.credentials.json'), '{}', 'utf8');
    const fresh = join(dir, 'fresh');
    seedConfigDir(fresh, operator);
    expect(readdirSync(fresh)).not.toContain('.credentials.json');
  });

  it('is a no-op the second time and says what it skipped', () => {
    const operator = operatorTree();
    const fresh = join(dir, 'fresh');
    const first = seedConfigDir(fresh, operator);
    const second = seedConfigDir(fresh, operator);
    expect(first.ok && first.created.length).toBeGreaterThan(0);
    if (!second.ok) throw new Error(second.reason);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual([...SEEDED_LINKS, ...SEEDED_COPIES]);
  });

  it('refuses a directory that already holds a real projects folder', () => {
    const operator = operatorTree();
    const inUse = join(dir, 'in-use');
    mkdirSync(join(inUse, 'projects'), { recursive: true });
    writeFileSync(join(inUse, 'projects', 'someones-work.jsonl'), '{}\n', 'utf8');

    const result = seedConfigDir(inUse, operator);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('projects');
    // And it left the directory exactly as it found it.
    expect(lstatSync(join(inUse, 'projects')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(inUse, 'projects', 'someones-work.jsonl'))).toBe(true);
    expect(existsSync(join(inUse, 'settings.json'))).toBe(false);
  });
});

// ---- the switch ---------------------------------------------------------------------

const NOW = 1_757_505_600_000;

function account(id: string, configDir: string, extra: Partial<AccountRecord> = {}): AccountRecord {
  return { id, provider: 'claude', label: id, email: id, configDir, connectedAt: NOW, ...extra };
}

function reading(pct: number): AccountUsage[string] {
  return { reading: { at: NOW, windows: [{ key: 'weekly', label: 'weekly', usedPct: pct, resetsAt: NOW + 86_400_000 }] } };
}

function limited(): AccountUsage[string] {
  return { windows: { five_hour: { limitedUntil: NOW + 3_600_000, seenAt: NOW } } };
}

describe('switching a terminal off a login that ran dry', () => {
  it('marks every live session on the limited login and queues one line each', () => {
    const from = join(dir, 'from');
    const to = join(dir, 'to');
    const messages: { sessionId: string; text: string }[] = [];
    const markers = switchLimitedAccount('spent', {
      accounts: [account('spent', from), account('spare', to)],
      usage: { spent: limited(), spare: reading(12) },
      live: {}, now: NOW,
      sessionsFor: (configDir) => (configDir === from ? ['sess-a', 'sess-b'] : []),
      queueMessage: (sessionId, text) => messages.push({ sessionId, text }),
      dir: join(dir, 'switch'),
    });

    expect(markers.map((m) => m.sessionId)).toEqual(['sess-a', 'sess-b']);
    for (const marker of markers) {
      expect(marker.toConfigDir).toBe(to);
      expect(marker.toLabel).toBe('spare');
      expect(marker.fromConfigDir).toBe(from);
      const onDisk = JSON.parse(readFileSync(markerPath(marker.sessionId, join(dir, 'switch')), 'utf8'));
      expect(onDisk.toConfigDir).toBe(to);
    }
    expect(messages.map((m) => m.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(messages[0]!.text).toBe(switchMessage('spare'));
    expect(messages[0]!.text).toContain('spare');
  });

  it('writes nothing for a login that is not actually limited', () => {
    const from = join(dir, 'from');
    const markers = switchLimitedAccount('fine', {
      accounts: [account('fine', from), account('spare', join(dir, 'to'))],
      usage: { fine: reading(40), spare: reading(12) },
      live: {}, now: NOW,
      sessionsFor: () => ['sess-a'],
      dir: join(dir, 'switch'),
    });
    expect(markers).toEqual([]);
    expect(existsSync(join(dir, 'switch'))).toBe(false);
  });

  it('still marks the session when nothing else has room, with a null target that says so', () => {
    const from = join(dir, 'from');
    const messages: string[] = [];
    const markers = switchLimitedAccount('spent', {
      accounts: [account('spent', from)],
      usage: { spent: limited() },
      live: {}, now: NOW,
      sessionsFor: () => ['sess-a'],
      queueMessage: (_id, text) => messages.push(text),
      dir: join(dir, 'switch'),
    });
    expect(markers).toHaveLength(1);
    expect(markers[0]!.toConfigDir).toBeNull();
    expect(markers[0]!.toLabel).toBeNull();
    expect(messages[0]).toBe(switchMessage(null));
    expect(messages[0]).toContain('no other login has room');
  });

  it('works with no message route wired at all', () => {
    const from = join(dir, 'from');
    const markers = switchLimitedAccount('spent', {
      accounts: [account('spent', from), account('spare', join(dir, 'to'))],
      usage: { spent: limited(), spare: reading(12) },
      live: {}, now: NOW,
      sessionsFor: () => ['sess-a'],
      dir: join(dir, 'switch'),
    });
    expect(markers).toHaveLength(1);
  });

  it('reads back only a fresh marker left for the directory that asked', () => {
    const switches = join(dir, 'switch');
    const from = join(dir, 'from');
    switchLimitedAccount('spent', {
      accounts: [account('spent', from), account('spare', join(dir, 'to'))],
      usage: { spent: limited(), spare: reading(12) },
      live: {}, now: NOW,
      sessionsFor: () => ['sess-a'],
      dir: switches,
    });

    expect(readSwitchMarker(from, NOW + 1000, switches)?.sessionId).toBe('sess-a');
    // Eleven minutes later the limit it was about may well have lifted.
    expect(readSwitchMarker(from, NOW + 11 * 60 * 1000, switches)).toBeNull();
    // And a marker left for a terminal on another login is not this terminal's.
    expect(readSwitchMarker(join(dir, 'somewhere-else'), NOW + 1000, switches)).toBeNull();

    clearSwitchMarker('sess-a', switches);
    expect(readSwitchMarker(from, NOW + 1000, switches)).toBeNull();
  });

  it('reads live session ids out of a config directory that has them', () => {
    const configDir = join(dir, 'has-sessions');
    mkdirSync(join(configDir, 'sessions'), { recursive: true });
    writeFileSync(join(configDir, 'sessions', '1234.json'), JSON.stringify({ sessionId: 'sess-x' }), 'utf8');
    writeFileSync(join(configDir, 'sessions', '5678.json'), 'not json at all', 'utf8');
    expect(sessionsFromConfigDir(configDir)).toEqual(['sess-x']);
    expect(sessionsFromConfigDir(join(dir, 'nothing-here'))).toEqual([]);
  });
});

// ---- the route a terminal asks --------------------------------------------------------

class NoActuator implements Actuator {
  async park(): Promise<boolean> { return true; }

  async nudge(): Promise<void> {}

  async resume(_run: RunId): Promise<void> {}

  async kill(_run: RunId, _decisionId: DecisionId): Promise<void> {}
}

function getRequest(url: string): IncomingMessage {
  return { method: 'GET', url, on() { return this; } } as unknown as IncomingMessage;
}

function capture(): { response: ServerResponse; result: Promise<{ status: number; body: any }> } {
  let done: (value: { status: number; body: any }) => void;
  const result = new Promise<{ status: number; body: any }>((resolve) => { done = resolve; });
  let status = 0;
  const response = {
    writeHead(code: number) { status = code; return response; },
    end(text?: string) { done({ status, body: text ? JSON.parse(text) : undefined }); },
  } as unknown as ServerResponse;
  return { response, result };
}

function server(authorized: boolean, registryPath: string): ConsoleWrites {
  return new ConsoleWrites({
    journalPath: join(dir, 'fleet.jsonl'),
    registry: new Registry(join(dir, 'registry')),
    inbox: new Inbox(join(dir, 'inbox')),
    actuator: new NoActuator(),
    authorized: (_request, response) => {
      if (authorized) return true;
      (response as unknown as { writeHead: (code: number) => void }).writeHead(401);
      (response as unknown as { end: (text?: string) => void }).end(JSON.stringify({ error: 'unauthorized' }));
      return false;
    },
    ledgerPath: join(dir, 'actions.jsonl'),
    capsOverridesPath: join(dir, 'caps.json'),
    rulesConfigPath: join(dir, 'rules.json'),
    integrationsConfigPath: join(dir, 'integrations.json'),
    accountsRegistryPath: registryPath,
  });
}

function writeStore(operatorPct: number, fleetPct: number): string {
  const operatorDir = join(dir, 'op');
  const fleetDir = join(dir, 'fl');
  const registryPath = join(dir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({
    accounts: [
      { ...account('operator', operatorDir, { lastResort: true }), email: 'aaron-personal' },
      { ...account('fleet', fleetDir), email: 'the-fleet' },
    ],
  }), 'utf8');
  mkdirSync(join(dir, 'accounts'), { recursive: true });
  writeFileSync(join(dir, 'accounts', 'usage.json'), JSON.stringify({
    operator: { reading: { at: Date.now(), windows: [{ key: 'weekly', label: 'weekly', usedPct: operatorPct, resetsAt: Date.now() + 86_400_000 }] } },
    fleet: { reading: { at: Date.now(), windows: [{ key: 'weekly', label: 'weekly', usedPct: fleetPct, resetsAt: Date.now() + 86_400_000 }] } },
  }), 'utf8');
  return registryPath;
}

describe('the pick route a terminal asks before it opens', () => {
  it('needs the server token', async () => {
    const registryPath = writeStore(7, 91);
    const { response, result } = capture();
    await server(false, registryPath).handle('/accounts/pick', getRequest('/accounts/pick?mode=interactive'), response);
    expect((await result).status).toBe(401);
  });

  it('answers with the login, its name and one sentence carrying the percent', async () => {
    const registryPath = writeStore(7, 91);
    const { response, result } = capture();
    await server(true, registryPath).handle('/accounts/pick', getRequest('/accounts/pick?mode=interactive'), response);
    const { status, body } = await result;
    expect(status).toBe(200);
    expect(body.label).toBe('aaron-personal');
    expect(body.configDir).toBe(join(dir, 'op'));
    expect(body.sentence).toBe('Using the aaron-personal login, at 7% of its weekly limit.');
    expect(body.sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('routes a worker off the operator login at the same numbers', async () => {
    const registryPath = writeStore(7, 91);
    const { response, result } = capture();
    await server(true, registryPath).handle('/accounts/pick', getRequest('/accounts/pick'), response);
    const { body } = await result;
    expect(body.label).toBe('the-fleet');
    expect(body.sentence).toBe('Using the the-fleet login, at 91% of its weekly limit.');
  });

  it('sends a terminal elsewhere once the operator login is nearly gone', async () => {
    const registryPath = writeStore(96, 30);
    const { response, result } = capture();
    await server(true, registryPath).handle('/accounts/pick', getRequest('/accounts/pick?mode=interactive'), response);
    const { body } = await result;
    expect(body.label).toBe('the-fleet');
    expect(body.sentence).toBe('Using the the-fleet login, at 30% of its weekly limit.');
  });
});

describe('one row per subscription', () => {
  // Two directories logged into ONE subscription add no headroom, and the registry held
  // exactly that once: the fleet login registered a second time under another path,
  // counted as a second account, so the pick believed in room that did not exist.
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('refuses a second row for a subscription already registered', () => {
    const existing = [account('fleet', '/dir/one', { accountUuid: uuid })];
    const verdict = checkAddCandidate(existing, { id: 'fleet-again', configDir: '/dir/two', accountUuid: uuid });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.reason).toContain('same subscription');
  });

  it('accepts two rows that really are two subscriptions', () => {
    const existing = [account('fleet', '/dir/one', { accountUuid: uuid })];
    const other = 'ffffffff-1111-2222-3333-444444444444';
    expect(checkAddCandidate(existing, { id: 'operator', configDir: '/dir/two', accountUuid: other }).ok).toBe(true);
  });

  it('cannot tell two rows apart when neither carries a subscription id', () => {
    // Named rather than asserted away: a row written before the id existed is not deduped
    // by it, so an unset `accountUuid` is a real gap and the registry says so by letting
    // this through. `forge accounts add` fills it in from a probe when the network allows.
    const rows = [account('a', '/dir/one'), account('b', '/dir/two')];
    expect(validateAccounts(rows).ok).toBe(true);
  });
});
