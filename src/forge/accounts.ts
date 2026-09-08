/**
 * The accounts registry: every login Forge may put work on.
 *
 * A Claude account is a config directory (`CLAUDE_CONFIG_DIR`) with its own login in
 * it. A Codex account is the one `~/.codex` login the harness tool uses; Codex has no
 * per-directory login and no quota API, so its row carries no directory.
 *
 * The registry lives at `~/.forge/accounts.json` (`accountsPath()`), untracked. With no
 * file, the registry is exactly what every worker launches with today: one Claude
 * account on `fleetConfigDir()` plus the Codex lane. This module decides nothing about
 * routing. Every launch still goes through `fleetConfigDir()`; the registry only names
 * accounts so runs and window rows can be attributed to one.
 *
 * Two refusals, both on add and on load: a `configDir` equal to the operator's own
 * `~/.claude`, which a worker must never share, and duplicate ids or directories.
 * Credential files under a config dir are never opened here or anywhere in Forge; the
 * only way a dir is checked is the SDK usage call the probe makes under it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { accountsPath, fleetConfigDir } from './paths.js';

export interface ClaudeAccount {
  id: string;
  provider: 'claude';
  configDir: string;
  /** Concurrency ceiling for slice 2's admission. Read, shown, not yet enforced. */
  maxConcurrent?: number;
}

export interface CodexAccount {
  id: string;
  provider: 'codex';
}

export type Account = ClaudeAccount | CodexAccount;

export interface AccountsRegistry {
  accounts: Account[];
  path: string;
  /** `default` for no file, `file` for a valid one, `invalid` for a file that would not
   *  parse or validate. An invalid file falls back to the default set so the fleet keeps
   *  running, and the reason is carried so the view can say so. */
  source: 'default' | 'file' | 'invalid';
  error?: string;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export const DEFAULT_CLAUDE_ID = 'fleet';
export const DEFAULT_CODEX_ID = 'codex';

export function defaultAccounts(fleetDir: string = fleetConfigDir()): Account[] {
  return [
    { id: DEFAULT_CLAUDE_ID, provider: 'claude', configDir: fleetDir },
    { id: DEFAULT_CODEX_ID, provider: 'codex' },
  ];
}

/** One comparable form for a directory: absolute, forward slashes, no trailing slash,
 *  and case folded on Windows where the filesystem is. */
export function normalizeDir(dir: string): string {
  let out = resolve(dir).replace(/\\/g, '/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

const ID_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function validateAccounts(accounts: Account[], ownDir: string = join(homedir(), '.claude')): Verdict {
  const own = normalizeDir(ownDir);
  const ids = new Set<string>();
  const dirs = new Set<string>();
  for (const account of accounts) {
    if (!ID_SHAPE.test(account.id)) return { ok: false, reason: `account id '${account.id}' must be letters, digits, dots, dashes or underscores` };
    if (ids.has(account.id)) return { ok: false, reason: `duplicate account id '${account.id}'` };
    ids.add(account.id);
    if (account.provider === 'codex') continue;
    if ((account as { provider: string }).provider !== 'claude') {
      return { ok: false, reason: `account '${account.id}' has an unknown provider` };
    }
    if (typeof account.configDir !== 'string' || !account.configDir.trim()) {
      return { ok: false, reason: `account '${account.id}' has no configDir` };
    }
    const dir = normalizeDir(account.configDir);
    if (dir === own) return { ok: false, reason: `account '${account.id}' points at the operator's own config dir; a worker never shares that login` };
    if (dirs.has(dir)) return { ok: false, reason: `account '${account.id}' repeats a config dir another account already uses` };
    dirs.add(dir);
    if (account.maxConcurrent !== undefined && (!Number.isInteger(account.maxConcurrent) || account.maxConcurrent < 1)) {
      return { ok: false, reason: `account '${account.id}' has a maxConcurrent that is not a positive integer` };
    }
  }
  return { ok: true };
}

function parseFile(text: string): Account[] {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { accounts?: unknown }).accounts)) {
    throw new Error('accounts.json must be an object with an "accounts" array');
  }
  return ((parsed as { accounts: unknown[] }).accounts).map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'] : '';
    if (row['provider'] === 'codex') return { id, provider: 'codex' } as CodexAccount;
    const account: ClaudeAccount = {
      id, provider: 'claude', configDir: typeof row['configDir'] === 'string' ? row['configDir'] : '',
    };
    if (typeof row['maxConcurrent'] === 'number') account.maxConcurrent = row['maxConcurrent'];
    return account;
  });
}

export function loadAccounts(path: string = accountsPath(), fleetDir: string = fleetConfigDir()): AccountsRegistry {
  if (!existsSync(path)) return { accounts: defaultAccounts(fleetDir), path, source: 'default' };
  let accounts: Account[];
  try {
    accounts = parseFile(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { accounts: defaultAccounts(fleetDir), path, source: 'invalid', error: `could not parse ${path}: ${message}` };
  }
  const verdict = validateAccounts(accounts);
  if (!verdict.ok) return { accounts: defaultAccounts(fleetDir), path, source: 'invalid', error: verdict.reason };
  return { accounts, path, source: 'file' };
}

export function saveAccounts(path: string, accounts: Account[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ accounts }, null, 2)}\n`, 'utf8');
}

export function addAccount(
  registry: AccountsRegistry,
  input: { id: string; configDir: string; maxConcurrent?: number },
): Verdict {
  if (registry.source === 'invalid') return { ok: false, reason: registry.error ?? 'the registry file is invalid; fix or remove it first' };
  const account: ClaudeAccount = { id: input.id, provider: 'claude', configDir: input.configDir };
  if (input.maxConcurrent !== undefined) account.maxConcurrent = input.maxConcurrent;
  const next = [...registry.accounts, account];
  const verdict = validateAccounts(next);
  if (!verdict.ok) return verdict;
  saveAccounts(registry.path, next);
  return { ok: true };
}

export function removeAccount(registry: AccountsRegistry, id: string): Verdict {
  if (registry.source === 'invalid') return { ok: false, reason: registry.error ?? 'the registry file is invalid; fix or remove it first' };
  if (!registry.accounts.some((account) => account.id === id)) return { ok: false, reason: `no account '${id}' in ${registry.path}` };
  saveAccounts(registry.path, registry.accounts.filter((account) => account.id !== id));
  return { ok: true };
}

export function claudeAccounts(accounts: Account[]): ClaudeAccount[] {
  return accounts.filter((account): account is ClaudeAccount => account.provider === 'claude');
}

/**
 * The registry id a config dir belongs to. A dir no account names is attributed by its
 * basename rather than dropped, so a run launched under a stranger still says where it
 * ran and the board can show the row as unregistered.
 */
export function accountIdForConfigDir(accounts: Account[], configDir: string): string {
  const wanted = normalizeDir(configDir);
  for (const account of claudeAccounts(accounts)) {
    if (normalizeDir(account.configDir) === wanted) return account.id;
  }
  return basename(configDir.replace(/[\\/]+$/, '')) || configDir;
}

/** The id every launch is attributed to today: the account on `fleetConfigDir()`. */
export function launchAccountId(registry: AccountsRegistry = loadAccounts(), fleetDir: string = fleetConfigDir()): string {
  return accountIdForConfigDir(registry.accounts, fleetDir);
}
