/**
 * Accounts: the registry, the two window signals (live event and probe), the fold behind
 * `GET /accounts`, and run attribution. No live SDK call anywhere here: every query is a
 * fake generator, so this file spends nothing on any account.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { Engine, type QueryFn } from '../../src/adapter/engine.js';
import type { EngineEvent } from '../../src/adapter/events.js';
import {
  accountIdForConfigDir, addAccount, checkAddCandidate, defaultAccounts, loadAccounts, removeAccount, validateAccounts,
} from '../../src/forge/accounts.js';
import { buildAccountsBoard } from '../../src/forge/accounts-board.js';
import { probeAccounts, windowsFromUsage } from '../../src/forge/accounts-probe.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { accountsPath } from '../../src/forge/paths.js';
import { SdkEngine } from '../../src/forge/sdkengine.js';
import { forge } from '../../src/forge/cli.js';

let home: string;
let journalPath: string;
let fleetDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-accounts-'));
  journalPath = join(home, 'fleet.jsonl');
  fleetDir = join(home, 'fleet-a');
  process.env['FORGE_HOME'] = home;
  process.env['FORGE_CONFIG_DIR'] = fleetDir;
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

describe('the accounts registry', () => {
  it('absent file: one Claude account on the fleet dir plus the Codex lane, exactly today', () => {
    const registry = loadAccounts(accountsPath(), fleetDir);
    expect(registry.source).toBe('default');
    expect(registry.accounts).toEqual(defaultAccounts(fleetDir));
    expect(registry.accounts.map((a) => a.provider)).toEqual(['claude', 'codex']);
    expect(registry.accounts[0]).toMatchObject({ id: 'fleet', configDir: fleetDir });
  });

  it('refuses a configDir equal to the operator\'s own ~/.claude, in either separator', () => {
    const own = join(homedir(), '.claude');
    const verdict = validateAccounts([{ id: 'me', provider: 'claude', configDir: own.replace(/\\/g, '/') }]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/own/);
  });

  it('refuses duplicate ids and duplicate config dirs', () => {
    const twoIds = validateAccounts([
      { id: 'a', provider: 'claude', configDir: join(home, 'x') },
      { id: 'a', provider: 'claude', configDir: join(home, 'y') },
    ]);
    expect(twoIds.ok).toBe(false);
    const twoDirs = validateAccounts([
      { id: 'a', provider: 'claude', configDir: join(home, 'x') },
      { id: 'b', provider: 'claude', configDir: join(home, 'X').replace(/\\/g, '/') + '/' },
    ]);
    expect(twoDirs.ok).toBe(process.platform === 'win32' ? false : true);
  });

  it('add writes the file with the defaults kept, remove takes one out, and an unknown id is refused', () => {
    const path = accountsPath();
    expect(existsSync(path)).toBe(false);
    const added = addAccount(loadAccounts(path, fleetDir), { id: 'fleet-b', configDir: join(home, 'fleet-b'), maxConcurrent: 3 });
    expect(added.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { accounts: Array<{ id: string }> };
    expect(onDisk.accounts.map((a) => a.id)).toEqual(['fleet', 'codex', 'fleet-b']);
    const reloaded = loadAccounts(path, fleetDir);
    expect(reloaded.source).toBe('file');
    const removed = removeAccount(reloaded, 'fleet-b');
    expect(removed.ok).toBe(true);
    expect(loadAccounts(path, fleetDir).accounts.map((a) => a.id)).toEqual(['fleet', 'codex']);
    expect(removeAccount(loadAccounts(path, fleetDir), 'nope').ok).toBe(false);
  });

  it('checkAddCandidate refuses the operator own dir and a duplicate without writing, so a probe never runs on either', () => {
    const registry = loadAccounts(accountsPath(), fleetDir);
    const own = checkAddCandidate(registry, { id: 'me', configDir: join(homedir(), '.claude') });
    expect(own.ok).toBe(false);
    const dup = checkAddCandidate(registry, { id: 'again', configDir: fleetDir });
    expect(dup.ok).toBe(false);
    const fresh = checkAddCandidate(registry, { id: 'fleet-b', configDir: join(home, 'fleet-b') });
    expect(fresh.ok).toBe(true);
    expect(existsSync(accountsPath())).toBe(false);
  });

  it('a corrupt or invalid file is reported, never silently replaced by the default', () => {
    const path = accountsPath();
    writeFileSync(path, '{ not json', 'utf8');
    const registry = loadAccounts(path, fleetDir);
    expect(registry.source).toBe('invalid');
    expect(registry.error).toMatch(/JSON|parse/i);
    expect(registry.accounts).toEqual(defaultAccounts(fleetDir));
  });

  it('attributes a config dir to the registered id, and falls back to the basename for a stranger', () => {
    const accounts = defaultAccounts(fleetDir);
    expect(accountIdForConfigDir(accounts, fleetDir)).toBe('fleet');
    expect(accountIdForConfigDir(accounts, fleetDir.replace(/\\/g, '/') + '/')).toBe('fleet');
    expect(accountIdForConfigDir(accounts, join(home, '.claude-other'))).toBe('.claude-other');
  });
});

describe('forge accounts', () => {
  it('list names the built-in account and where the registry would be', async () => {
    const result = await forge(['accounts', 'list']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toContain(fleetDir);
    expect(result.lines.join(' ')).toContain('every launch goes here today');
    expect(result.lines.at(-1)).toContain('built in');
  });

  it('add refuses the operator own dir before any probe runs, and journals nothing', async () => {
    const result = await forge(['accounts', 'add', 'me', join(homedir(), '.claude')]);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/own config dir/);
    expect(existsSync(journalPath) ? replay(journalPath).events.filter((e) => e.event === 'account.probe') : []).toEqual([]);
    expect(existsSync(accountsPath())).toBe(false);
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
  it('journals account.probe and one account.window per window under each Claude account, and never yields a turn', async () => {
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
        { id: 'fleet', provider: 'claude', configDir: fleetDir },
        { id: 'fleet-b', provider: 'claude', configDir: join(home, 'fleet-b') },
        { id: 'codex', provider: 'codex' },
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
        { id: 'a', provider: 'claude', configDir: join(home, 'a') },
        { id: 'b', provider: 'claude', configDir: join(home, 'b') },
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

// ---------------------------------------------------------------------------------------
// Attribution: run.started carries the account, and the worker's engine journals the
// live rate-limit event under it
// ---------------------------------------------------------------------------------------

describe('a live worker journals account.window under its account', () => {
  it('rate_limit_event on a turn lands as account.window tagged with the launch account', async () => {
    let asked = false;
    const fn = (() => {
      async function* generate() {
        yield { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5', cwd: '/', tools: [], slash_commands: [] };
        for await (const _pushed of [1] as unknown as AsyncIterable<unknown>) {
          if (asked) return;
          asked = true;
          yield {
            type: 'assistant', session_id: 's1',
            message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1 } },
          };
          yield { type: 'rate_limit_event', session_id: 's1', uuid: 'u', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1788907200 } };
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = new SdkEngine({ journalPath, inboxDir: join(home, 'inbox'), gotchasDir: join(home, 'gotchas'), queryFn: fn });
    await engine.run({ run: 'r1', model: 'claude-sonnet-5', prompt: '# Goal\n\ndo it\n', cwd: join(home, 'ws'), maxTurns: 10, env: {} });
    await engine.close();

    const state = replay(journalPath);
    const row = state.events.find((e) => e.event === 'account.window');
    expect(row).toMatchObject({ run: 'r1', actor: 'worker', account: 'fleet', window: 'five_hour', status: 'allowed', resetsAt: 1788907200_000 });
  });
});

// ---------------------------------------------------------------------------------------
// Board fold
// ---------------------------------------------------------------------------------------

describe('buildAccountsBoard', () => {
  it('one row per account: windows from the latest row, tokens today by attribution, live runs, connected state', () => {
    const now = Date.parse('2026-09-08T18:00:00Z');
    const journal = new Journal(journalPath);
    journal.append({ event: 'run.started', run: 'r1', actor: 'runner', model: 'claude-sonnet-5', account: 'fleet' });
    journal.append({ event: 'turn.end', run: 'r1', actor: 'worker', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 50 }, model: 'claude-sonnet-5' });
    journal.append({ event: 'run.started', run: 'r2', actor: 'runner', model: 'claude-sonnet-5', account: 'fleet-b' });
    journal.append({ event: 'run.finished', run: 'r2', actor: 'runner' });
    journal.append({ event: 'run.started', run: 'r0', actor: 'runner', model: 'claude-sonnet-5' });
    journal.append({ event: 'turn.end', run: 'r0', actor: 'worker', usage: { input: 7, cacheRead: 0, cacheCreation: 0, output: 0 }, model: 'claude-sonnet-5' });
    journal.append({ event: 'account.probe', actor: 'probe', account: 'fleet', ok: true });
    journal.append({ event: 'account.window', actor: 'probe', account: 'fleet', window: 'five_hour', status: 'allowed', utilization: 20, resetsAt: now + 1000 });
    journal.append({ event: 'account.window', actor: 'probe', account: 'fleet', window: 'seven_day', status: 'allowed', utilization: 61, resetsAt: null });
    journal.append({ event: 'account.window', actor: 'worker', run: 'r1', account: 'fleet', window: 'five_hour', status: 'allowed_warning', utilization: 85, resetsAt: now + 2000 });
    journal.append({ event: 'account.probe', actor: 'probe', account: 'fleet-b', ok: false, error: 'not logged in' });
    journal.close();

    const board = buildAccountsBoard({
      accounts: [
        { id: 'fleet', provider: 'claude', configDir: fleetDir, maxConcurrent: 4 },
        { id: 'fleet-b', provider: 'claude', configDir: join(home, 'fleet-b') },
        { id: 'codex', provider: 'codex' },
      ],
      fleet: replay(journalPath),
      codexLedgerLines: [
        JSON.stringify({ ok: true, duration_s: 100, at: new Date(now - 60_000).toISOString() }),
        JSON.stringify({ ok: false, error: 'codex failed (exit 1)', duration_s: 5, at: new Date(now - 30_000).toISOString() }),
        JSON.stringify({ ok: true, duration_s: 999, at: '2026-09-01T00:00:00Z' }),
      ],
      now, launchAccount: 'fleet',
    });

    const fleet = board.accounts.find((a) => a.id === 'fleet');
    expect(fleet).toMatchObject({
      provider: 'claude', connected: 'yes', liveRuns: 1, tokensToday: 150, isLaunchAccount: true, maxConcurrent: 4,
      fiveHour: { utilization: 85, status: 'allowed_warning', resetsAt: now + 2000 },
      sevenDay: { utilization: 61, status: 'allowed', resetsAt: null },
    });
    expect(fleet?.lastEvent).toMatchObject({ window: 'five_hour', status: 'allowed_warning', actor: 'worker' });
    const b = board.accounts.find((a) => a.id === 'fleet-b');
    expect(b).toMatchObject({ connected: 'no', connectedReason: 'not logged in', liveRuns: 0, tokensToday: 0, isLaunchAccount: false });
    expect(b?.fiveHour).toMatchObject({ utilization: null, status: 'unknown' });
    const codex = board.accounts.find((a) => a.id === 'codex');
    expect(codex).toMatchObject({
      provider: 'codex', connected: 'yes', connectedReason: null,
      codex: { callsToday: 2, durationTodayMs: 105_000, lastError: 'codex failed (exit 1)', lastOkAt: now - 60_000 },
    });
    expect(board.unattributedTokensToday).toBe(7);
  });

  it('an unavailable probe row keeps the last known utilization but says so', () => {
    const now = Date.now();
    const journal = new Journal(journalPath);
    journal.append({ event: 'account.window', actor: 'probe', account: 'fleet', window: 'five_hour', status: 'allowed', utilization: 40, resetsAt: now + 1000 });
    journal.append({ event: 'account.window', actor: 'probe', account: 'fleet', window: 'five_hour', status: 'unavailable', utilization: null, resetsAt: null });
    journal.close();
    const board = buildAccountsBoard({
      accounts: [{ id: 'fleet', provider: 'claude', configDir: fleetDir }],
      fleet: replay(journalPath), codexLedgerLines: [], now, launchAccount: 'fleet',
    });
    expect(board.accounts[0]?.fiveHour).toMatchObject({ utilization: 40, status: 'unavailable', resetsAt: now + 1000 });
  });

  it('a rejected window reads as paused until its reset', () => {
    const now = Date.now();
    const journal = new Journal(journalPath);
    journal.append({ event: 'account.window', actor: 'worker', run: 'r1', account: 'fleet', window: 'five_hour', status: 'rejected', utilization: 100, resetsAt: now + 60_000 });
    journal.close();
    const board = buildAccountsBoard({
      accounts: [{ id: 'fleet', provider: 'claude', configDir: fleetDir }],
      fleet: replay(journalPath), codexLedgerLines: [], now, launchAccount: 'fleet',
    });
    expect(board.accounts[0]?.paused).toEqual({ until: now + 60_000, window: 'five_hour' });
    const later = buildAccountsBoard({
      accounts: [{ id: 'fleet', provider: 'claude', configDir: fleetDir }],
      fleet: replay(journalPath), codexLedgerLines: [], now: now + 61_000, launchAccount: 'fleet',
    });
    expect(later.accounts[0]?.paused).toBeNull();
  });
});
