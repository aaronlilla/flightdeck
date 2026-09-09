/**
 * Accounts: the registry, its validation refusals, the two window signals (live event
 * and probe), and run attribution. No live SDK call anywhere here: every query is a
 * fake generator, so this file spends nothing on any account.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { Engine, type QueryFn } from '../../src/adapter/engine.js';
import type { EngineEvent } from '../../src/adapter/events.js';
import {
  accountsRegistryPath, addAccount, checkAddCandidate, liveRunsByAccount, loadAccounts, normalizeDir, removeAccount, validateAccounts,
} from '../../src/forge/accounts.js';
import { probeAccounts, windowsFromUsage } from '../../src/forge/accounts-probe.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { forge } from '../../src/forge/cli.js';

let home: string;
let journalPath: string;
let fleetDir: string;
let registryPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-accounts-'));
  journalPath = join(home, 'fleet.jsonl');
  fleetDir = join(home, 'fleet-a');
  process.env['FORGE_HOME'] = home;
  process.env['FORGE_CONFIG_DIR'] = fleetDir;
  registryPath = accountsRegistryPath();
});

// ---------------------------------------------------------------------------------------
// The adapter surfaces the SDK's rate_limit_event
// ---------------------------------------------------------------------------------------

describe('the adapter surfaces rate_limit_event as a typed rate-limit event', () => {
  it('maps status, window and utilization, and converts resetsAt from seconds to ms', async () => {
    const fn = (() => {
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's1',
          model: 'claude-sonnet-5', cwd: '/', tools: [], slash_commands: [],
        };
        yield {
          type: 'rate_limit_event', session_id: 's1', uuid: 'u1',
          rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 82, resetsAt: 1788907200 },
        };
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = new Engine(fn);
    const seen: EngineEvent[] = [];
    engine.onEvent((event) => seen.push(event));
    engine.start({ cwd: '/', canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const event = seen.find((e) => e.type === 'rate-limit') as Extract<EngineEvent, { type: 'rate-limit' }> | undefined;
    expect(event, 'rate_limit_event must not fall to unknown-message').toBeTruthy();
    expect(event).toMatchObject({ status: 'allowed_warning', window: 'five_hour', utilization: 82, resetsAt: 1788907200_000 });
    expect(seen.some((e) => e.type === 'unknown-message')).toBe(false);
  });

  it('leaves utilization and resetsAt null when the event carries neither (the live shape on an ordinary turn)', async () => {
    const fn = (() => {
      async function* generate() {
        yield { type: 'rate_limit_event', session_id: 's1', uuid: 'u1', rate_limit_info: { status: 'allowed' } };
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;
    const engine = new Engine(fn);
    const seen: EngineEvent[] = [];
    engine.onEvent((event) => seen.push(event));
    engine.start({ cwd: '/', canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const event = seen.find((e) => e.type === 'rate-limit') as Extract<EngineEvent, { type: 'rate-limit' }>;
    expect(event).toMatchObject({ status: 'allowed', window: null, utilization: null, resetsAt: null });
  });
});

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

describe('the account registry file', () => {
  it('reads an empty list when no registry file exists yet', () => {
    expect(loadAccounts(registryPath)).toEqual([]);
  });

  it('adds an account and reads it back', () => {
    addAccount({ id: 'test-a', label: 'work', configDir: join(home, 'accounts', 'test-a'), connectedAt: 1000 }, registryPath);
    const accounts = loadAccounts(registryPath);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: 'test-a', label: 'work', connectedAt: 1000 });
  });

  it('adds a second account alongside the first, rather than overwriting it', () => {
    addAccount({ id: 'test-a', label: 'work', configDir: join(home, 'accounts', 'test-a'), connectedAt: 1000 }, registryPath);
    addAccount({ id: 'test-b', label: 'personal', configDir: join(home, 'accounts', 'test-b'), connectedAt: 2000 }, registryPath);
    expect(loadAccounts(registryPath).map((a) => a.id)).toEqual(['test-a', 'test-b']);
  });

  it('removes an account by id, leaving the rest untouched', () => {
    addAccount({ id: 'test-a', label: 'work', configDir: join(home, 'accounts', 'test-a'), connectedAt: 1000 }, registryPath);
    addAccount({ id: 'test-b', label: 'personal', configDir: join(home, 'accounts', 'test-b'), connectedAt: 2000 }, registryPath);
    removeAccount('test-a', registryPath);
    expect(loadAccounts(registryPath).map((a) => a.id)).toEqual(['test-b']);
  });

  it('removing an id that is not there is a no-op, not a throw', () => {
    addAccount({ id: 'test-a', label: 'work', configDir: join(home, 'accounts', 'test-a'), connectedAt: 1000 }, registryPath);
    expect(() => removeAccount('test-nope', registryPath)).not.toThrow();
    expect(loadAccounts(registryPath)).toHaveLength(1);
  });

  it('tolerates a torn or missing registry file by reading an empty list', () => {
    expect(loadAccounts(join(home, 'nowhere', 'registry.json'))).toEqual([]);
  });
});

describe('validateAccounts: the registry\'s own refusals', () => {
  it('refuses an id that is not letters, digits, dots, dashes or underscores', () => {
    const verdict = validateAccounts([{ id: 'has a space', label: 'x', configDir: join(home, 'x'), connectedAt: 0 }]);
    expect(verdict.ok).toBe(false);
  });

  it('refuses a configDir equal to the operator\'s own ~/.claude, in either separator', () => {
    const own = join(homedir(), '.claude');
    const verdict = validateAccounts([{ id: 'me', label: 'me', configDir: own.replace(/\\/g, '/'), connectedAt: 0 }]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/own/);
  });

  it('refuses duplicate ids and duplicate config dirs', () => {
    const twoIds = validateAccounts([
      { id: 'a', label: 'a', configDir: join(home, 'x'), connectedAt: 0 },
      { id: 'a', label: 'a2', configDir: join(home, 'y'), connectedAt: 0 },
    ]);
    expect(twoIds.ok).toBe(false);
    const twoDirs = validateAccounts([
      { id: 'a', label: 'a', configDir: join(home, 'x'), connectedAt: 0 },
      { id: 'b', label: 'b', configDir: join(home, 'X').replace(/\\/g, '/') + '/', connectedAt: 0 },
    ]);
    expect(twoDirs.ok).toBe(process.platform === 'win32' ? false : true);
  });

  it('refuses a maxConcurrent that is not a positive integer', () => {
    const verdict = validateAccounts([{ id: 'a', label: 'a', configDir: join(home, 'x'), connectedAt: 0, maxConcurrent: 0 }]);
    expect(verdict.ok).toBe(false);
  });

  it('normalizeDir folds separators and trailing slashes, and case on Windows', () => {
    const a = normalizeDir(join(home, 'X') + '/');
    const b = normalizeDir(join(home, 'x'));
    expect(a).toBe(process.platform === 'win32' ? b : a);
  });

  it('addAccount refuses via validateAccounts and never writes on a refusal', () => {
    expect(() => addAccount({ id: 'me', label: 'me', configDir: join(homedir(), '.claude'), connectedAt: 0 }, registryPath))
      .toThrow(/own config dir/);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('checkAddCandidate refuses the operator own dir and a duplicate without writing, so a probe never runs on either', () => {
    addAccount({ id: 'fleet-a', label: 'fleet-a', configDir: fleetDir, connectedAt: 0 }, registryPath);
    const existing = loadAccounts(registryPath);
    const own = checkAddCandidate(existing, { id: 'me', configDir: join(homedir(), '.claude') });
    expect(own.ok).toBe(false);
    const dup = checkAddCandidate(existing, { id: 'again', configDir: fleetDir });
    expect(dup.ok).toBe(false);
    const fresh = checkAddCandidate(existing, { id: 'fleet-b', configDir: join(home, 'fleet-b') });
    expect(fresh.ok).toBe(true);
  });
});

describe('liveRunsByAccount: counted fresh from events and the currently live goals', () => {
  it('counts a run against the account its run.started row named', () => {
    const events = [
      { event: 'run.started', run: 'goal-1', actor: 'runner', account: 'test-a' },
      { event: 'run.started', run: 'goal-2', actor: 'runner', account: 'test-b' },
    ] as never[];
    expect(liveRunsByAccount(events, ['goal-1', 'goal-2'])).toEqual({ 'test-a': 1, 'test-b': 1 });
  });

  it('never counts a goal that is no longer live, even if it once ran on this account', () => {
    const events = [
      { event: 'run.started', run: 'goal-1', actor: 'runner', account: 'test-a' },
    ] as never[];
    expect(liveRunsByAccount(events, [])).toEqual({});
  });

  it('sums more than one live run on the same account', () => {
    const events = [
      { event: 'run.started', run: 'goal-1', actor: 'runner', account: 'test-a' },
      { event: 'run.started', run: 'goal-2', actor: 'runner', account: 'test-a' },
    ] as never[];
    expect(liveRunsByAccount(events, ['goal-1', 'goal-2'])).toEqual({ 'test-a': 2 });
  });
});

describe('forge accounts', () => {
  it('list says there are none yet with an empty registry', async () => {
    const result = await forge(['accounts', 'list']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/no accounts yet/);
  });

  it('list names a registered account and its config dir', async () => {
    addAccount({ id: 'fleet-a', label: 'fleet-a', configDir: fleetDir, connectedAt: 0 }, registryPath);
    const result = await forge(['accounts', 'list']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toContain(fleetDir);
  });

  it('add refuses the operator own dir before any probe runs, and journals nothing', async () => {
    const result = await forge(['accounts', 'add', 'me', join(homedir(), '.claude')]);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/own config dir/);
    expect(existsSync(journalPath) ? replay(journalPath).events.filter((e) => e.event === 'account.probe') : []).toEqual([]);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('add refuses a dir that does not exist without probing it', async () => {
    const result = await forge(['accounts', 'add', 'ghost', join(home, 'nowhere')]);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/does not exist/);
    expect(existsSync(journalPath) ? replay(journalPath).events.filter((e) => e.event === 'account.probe') : []).toEqual([]);
  });

  it('remove refuses an id the registry does not have', async () => {
    const result = await forge(['accounts', 'remove', 'nope']);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/no account 'nope'/);
  });
});

// ---------------------------------------------------------------------------------------
// Probe parser
// ---------------------------------------------------------------------------------------

describe('windowsFromUsage', () => {
  it('reads both windows from a live-shaped usage response', () => {
    const rows = windowsFromUsage({
      subscription_type: 'max', rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12.5, resets_at: '2026-09-08T20:00:00Z' },
        seven_day: { utilization: 0, resets_at: null },
      },
    });
    expect(rows).toEqual([
      { window: 'five_hour', status: 'allowed', utilization: 12.5, resetsAt: Date.parse('2026-09-08T20:00:00Z') },
      { window: 'seven_day', status: 'allowed', utilization: 0, resetsAt: null },
    ]);
  });

  it('a window at 100 reads as rejected; rate_limits_available false reads as unavailable for both', () => {
    const full = windowsFromUsage({
      subscription_type: 'max', rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 100, resets_at: null }, seven_day: { utilization: 40, resets_at: null } },
    });
    expect(full[0]?.status).toBe('rejected');
    const none = windowsFromUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null });
    expect(none.map((r) => r.status)).toEqual(['unavailable', 'unavailable']);
    expect(none.map((r) => r.utilization)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------------------
// The probe itself, against a fake query
// ---------------------------------------------------------------------------------------

describe('probeAccounts', () => {
  it('journals account.probe and one account.window per window under each account, and never yields a turn', async () => {
    const dirsSeen: string[] = [];
    let interrupted = 0;
    let pulled = 0;
    const fn = ((args: { prompt: AsyncIterable<unknown>; options: { env: Record<string, string> } }) => {
      dirsSeen.push(args.options.env['CLAUDE_CONFIG_DIR'] ?? '');
      const iterator = args.prompt[Symbol.asyncIterator]();
      async function* generate() {
        // Pull once from the input, as the real SDK would: it must never resolve to a turn.
        void iterator.next().then((result) => { if (!result.done) pulled += 1; });
        yield* [] as unknown[];
      }
      const handle = generate() as unknown as Record<string, unknown>;
      handle['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'] = async () => ({
        subscription_type: 'max', rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 33, resets_at: '2026-09-08T20:00:00Z' }, seven_day: { utilization: 5, resets_at: null } },
        session: { model_usage: {} },
      });
      handle['interrupt'] = async () => { interrupted += 1; };
      return handle as unknown as Query;
    }) as unknown as QueryFn;

    const journal = new Journal(journalPath);
    const results = await probeAccounts({
      accounts: [
        { id: 'fleet', label: 'fleet', configDir: fleetDir, connectedAt: 0 },
        { id: 'fleet-b', label: 'fleet-b', configDir: join(home, 'fleet-b'), connectedAt: 0 },
      ],
      journal, queryFn: fn, cwd: home, timeoutMs: 2000,
    });
    journal.close();

    expect(dirsSeen).toEqual([fleetDir, join(home, 'fleet-b')]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(interrupted).toBe(2);
    expect(pulled, 'the streaming input must never yield a message').toBe(0);
    const state = replay(journalPath);
    const probes = state.events.filter((e) => e.event === 'account.probe');
    expect(probes.map((p) => [p['account'], p['ok']])).toEqual([['fleet', true], ['fleet-b', true]]);
    const windows = state.events.filter((e) => e.event === 'account.window');
    expect(windows).toHaveLength(4);
    expect(windows[0]).toMatchObject({ account: 'fleet', actor: 'probe', window: 'five_hour', status: 'allowed', utilization: 33 });
  });

  it('a usage call that throws journals a failed probe and no window row, and moves on to the next account', async () => {
    let calls = 0;
    const fn = (() => {
      calls += 1;
      const failing = calls === 1;
      async function* generate() { yield* [] as unknown[]; }
      const handle = generate() as unknown as Record<string, unknown>;
      handle['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'] = async () => {
        if (failing) throw new Error('not logged in');
        return { subscription_type: null, rate_limits_available: false, rate_limits: null, session: { model_usage: {} } };
      };
      handle['interrupt'] = async () => {};
      return handle as unknown as Query;
    }) as unknown as QueryFn;
    const journal = new Journal(journalPath);
    const results = await probeAccounts({
      accounts: [
        { id: 'a', label: 'a', configDir: join(home, 'a'), connectedAt: 0 },
        { id: 'b', label: 'b', configDir: join(home, 'b'), connectedAt: 0 },
      ],
      journal, queryFn: fn, cwd: home, timeoutMs: 2000,
    });
    journal.close();
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    const state = replay(journalPath);
    const probes = state.events.filter((e) => e.event === 'account.probe');
    expect(probes[0]).toMatchObject({ account: 'a', ok: false, error: 'not logged in' });
    const windows = state.events.filter((e) => e.event === 'account.window');
    expect(windows.map((w) => [w['account'], w['status']])).toEqual([['b', 'unavailable'], ['b', 'unavailable']]);
  });
});

